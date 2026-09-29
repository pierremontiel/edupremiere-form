/**
 * Edupremiere — student document uploads: R2 (Cloudflare) -> Google Drive
 *
 * Runs as Pierre every 10 minutes. For each file uploaded on
 * contact.edupremiere.com/documents it:
 *   1. copies the file into the student's Drive folder (or "00 To Sort" if the
 *      student has no folder yet), named "NEW - <Student> - <Type> - <file>",
 *   2. tells the Worker it's saved (the Worker writes the Drive link in
 *      Airtable › DOCUMENTS and deletes the file from R2).
 *
 * Setup (once):
 *   - Project Settings › Script properties: UPLOAD_SECRET = same value as the
 *     Cloudflare Worker secret UPLOAD_SECRET.
 *   - Run `setup` once and accept the permissions (creates the 10-min trigger).
 */

const WORKER = 'https://contact.edupremiere.com';
const TO_SORT_FOLDER_ID = '1mu0UvzcHA_5qVNU2SAwrUw4mO0qNUsum'; // Edupremiere Admin › 00 To Sort
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

function folderIdFor_(f) {
  const m = (f.folderUrl || '').match(/folders\/([A-Za-z0-9_-]+)/);
  return m ? m[1] : TO_SORT_FOLDER_ID;
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
