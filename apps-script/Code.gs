/**
 * Edupremiere — student document uploads: R2 (Cloudflare) -> Google Drive
 *
 * Runs as Pierre every 10 minutes. For each file uploaded on
 * contact.edupremiere.com/documents it:
 *   1. copies the file into "<student folder>/00 To Sort" (creating the student
 *      folder under 01 Students › In process if they have none yet), named
 *      "NEW - <Student> - <Type> - <file>",
 *   2. tells the Worker it's saved (the Worker writes the Drive link in
 *      Airtable › DOCUMENTS and deletes the file from R2).
 *
 * Setup (once):
 *   - Project Settings › Script properties: UPLOAD_SECRET = same value as the
 *     Cloudflare Worker secret UPLOAD_SECRET.
 *   - Run `setup` once and accept the permissions (creates the 10-min trigger).
 */

const WORKER = 'https://contact.edupremiere.com';
const TO_SORT_FOLDER_ID = '1mu0UvzcHA_5qVNU2SAwrUw4mO0qNUsum'; // Edupremiere Admin › 00 To Sort (fallback only)
const STUDENTS_FOLDER_ID = '1wjaBTnd_XVkjsS8GFRTaBLWVSjkumtQZ'; // Edupremiere Admin › 01 Students
const IN_PROCESS_FOLDER_ID = '1VhPep6kH1IyIHEFlMzQxNt8V056bqun-'; // 01 Students › In process
const TO_SORT_NAME = '00 To Sort'; // created inside each student folder
const CHUNK = 8 * 1024 * 1024; // 8 MB (multiple of 256 KB, required by Drive)

function setup() {
  ScriptApp.getProjectTriggers().forEach(t => ScriptApp.deleteTrigger(t));
  ScriptApp.newTrigger('syncUploads').timeBased().everyMinutes(10).create();
  DriveApp.getFolderById(TO_SORT_FOLDER_ID); // forces the Drive permission prompt
  syncUploads();
}

function secret_() {
  const s = PropertiesService.getScriptProperties().getProperty('UPLOAD_SECRET');
  if (!s) throw new Error('Missing script property UPLOAD_SECRET');
  return s;
}

function syncUploads() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(1000)) return; // previous run still busy
  try {
    const headers = { 'X-Upload-Secret': secret_() };
    const res = UrlFetchApp.fetch(WORKER + '/api/doc-pending', { headers, muteHttpExceptions: true });
    if (res.getResponseCode() !== 200) throw new Error('pending: ' + res.getContentText());
    const files = JSON.parse(res.getContentText()).files || [];
    const started = Date.now();
    for (const f of files) {
      if (Date.now() - started > 4.5 * 60 * 1000) break; // stay under the 6-min limit
      try {
        const id = transfer_(f, headers);
        const cb = UrlFetchApp.fetch(WORKER + '/api/doc-stored', {
          method: 'post', contentType: 'application/json', headers, muteHttpExceptions: true,
          payload: JSON.stringify({ key: f.key, docRowId: f.docRowId, driveFileId: id }),
        });
        if (cb.getResponseCode() !== 200) console.error('stored callback failed', f.key, cb.getContentText());
      } catch (e) {
        console.error('transfer failed', f.key, e);
      }
    }
  } finally {
    lock.releaseLock();
  }
}

// "Serigne  saliou  DIOP" and "serigne saliou diop" must match the same folder.
function norm_(s) {
  return String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase().replace(/[^a-z0-9]+/g, '');
}

// Lazy index of every existing student folder, across In process / Enrolled /
// Non active, built once per execution: { normalisedName: folderId }.
let STUDENT_INDEX = null;
function studentIndex_() {
  if (STUDENT_INDEX) return STUDENT_INDEX;
  STUDENT_INDEX = {};
  const sections = DriveApp.getFolderById(STUDENTS_FOLDER_ID).getFolders();
  while (sections.hasNext()) {
    const kids = sections.next().getFolders();
    while (kids.hasNext()) {
      const k = kids.next();
      const key = norm_(k.getName());
      if (key && !STUDENT_INDEX[key]) STUDENT_INDEX[key] = k.getId();
    }
  }
  return STUDENT_INDEX;
}

// The student's own folder: the Airtable "Google Drive Folder" link when set,
// otherwise an existing folder matched by name, otherwise a new one under
// "In process". Returns null only when we have no student name to work with.
function studentFolder_(f) {
  const m = (f.folderUrl || '').match(/folders\/([A-Za-z0-9_-]+)/);
  if (m) {
    try { return DriveApp.getFolderById(m[1]); }
    catch (e) { console.error('folderUrl unusable for ' + f.studentName, e); }
  }
  const key = norm_(f.studentName);
  if (!key) return null;
  const hit = studentIndex_()[key];
  if (hit) return DriveApp.getFolderById(hit);
  const created = DriveApp.getFolderById(IN_PROCESS_FOLDER_ID)
    .createFolder(String(f.studentName).trim());
  STUDENT_INDEX[key] = created.getId();
  console.log('created student folder: ' + created.getName());
  return created;
}

// Uploads land in "<student folder>/00 To Sort" so one student's unchecked
// files are never mixed with another's. Top-level "00 To Sort" stays as the
// fallback for the case where we cannot work out a student folder at all.
function folderIdFor_(f) {
  try {
    const student = studentFolder_(f);
    if (!student) return TO_SORT_FOLDER_ID;
    const kids = student.getFolders();
    while (kids.hasNext()) {
      const k = kids.next();
      if (norm_(k.getName()) === norm_(TO_SORT_NAME)) return k.getId();
    }
    return student.createFolder(TO_SORT_NAME).getId();
  } catch (e) {
    console.error('folderIdFor_ fell back to 00 To Sort for ' + f.studentName, e);
    return TO_SORT_FOLDER_ID;
  }
}

function transfer_(f, headers) {
  const size = parseInt(f.size, 10);
  const type = f.type && f.type !== 'Autre' ? f.type : 'Other';
  const name = ['NEW', f.studentName, type, f.originalName].filter(Boolean).join(' - ').replace(/[\/\\]/g, '-');
  const token = ScriptApp.getOAuthToken();

  // Start a resumable Drive upload
  const init = UrlFetchApp.fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&supportsAllDrives=true', {
    method: 'post', contentType: 'application/json',
    headers: { Authorization: 'Bearer ' + token, 'X-Upload-Content-Length': String(size) },
    payload: JSON.stringify({ name, parents: [folderIdFor_(f)] }),
    muteHttpExceptions: true,
  });
  if (init.getResponseCode() !== 200) throw new Error('drive init: ' + init.getContentText());
  const session = init.getHeaders()['Location'] || init.getHeaders()['location'];

  // Copy in chunks: Worker (R2, Range) -> Drive
  let start = 0, last;
  while (start < size) {
    const end = Math.min(start + CHUNK, size) - 1;
    const part = UrlFetchApp.fetch(WORKER + '/api/doc-file?key=' + encodeURIComponent(f.key), {
      headers: Object.assign({ Range: 'bytes=' + start + '-' + end }, headers), muteHttpExceptions: true,
    });
    if (part.getResponseCode() !== 206 && part.getResponseCode() !== 200) throw new Error('r2 read: ' + part.getResponseCode());
    last = UrlFetchApp.fetch(session, {
      method: 'put', contentType: 'application/octet-stream',
      headers: { 'Content-Range': 'bytes ' + start + '-' + end + '/' + size },
      payload: part.getBlob().getBytes(), muteHttpExceptions: true,
    });
    const code = last.getResponseCode();
    if (code !== 308 && code !== 200 && code !== 201) throw new Error('drive put: ' + code + ' ' + last.getContentText());
    start = end + 1;
  }
  return JSON.parse(last.getContentText()).id;
}
