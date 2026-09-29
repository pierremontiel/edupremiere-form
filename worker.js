export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname === "/api/submit" && request.method === "POST") {
      return handleSubmit(request, env);
    }

    if (url.pathname === "/api/submit-full" && request.method === "POST") {
      return handleFullSubmit(request, env);
    }
    if (url.pathname === "/documents" || url.pathname === "/documents/") {
      return env.ASSETS.fetch(new Request(new URL("/upload.html", request.url), request));
    }
    if (url.pathname === "/api/doc-lookup" && request.method === "POST") return docLookup(request, env);
    if (url.pathname === "/api/doc-upload" && request.method === "PUT") return docUpload(request, env);
    if (url.pathname === "/api/doc-pending" && request.method === "GET") return docPending(request, env);
    if (url.pathname === "/api/doc-file" && request.method === "GET") return docFile(request, env);
    if (url.pathname === "/api/doc-stored" && request.method === "POST") return docStored(request, env);

    if (url.pathname === "/" && url.hostname === "inscription.edupremiere.com") {
     return env.ASSETS.fetch(new Request(new URL("/full-form.html", request.url), request));
   }
    
    // Everything else: serve the static files (index.html, full-form.html, logo.jpg, etc.)
    return env.ASSETS.fetch(request);
  }
};

function normalizePhone(phone) {
  const digits = String(phone || "").replace(/[^0-9]/g, "");
  return digits.slice(-8);
}

// ---------- Short form (initial contact) ----------
async function handleSubmit(request, env) {
  try {
    const data = await request.json();

    if (!data.fullName || !data.phone) {
      return new Response(JSON.stringify({ error: "Missing required fields" }), { status: 400 });
    }

    const AIRTABLE_TOKEN = env.AIRTABLE_TOKEN;
    const AIRTABLE_BASE_ID = env.AIRTABLE_BASE_ID;
    const AIRTABLE_TABLE_NAME = env.AIRTABLE_TABLE_NAME || "STUDENTS";

    const fields = {
      "Nom et prénom": data.fullName,
      "Numéro WhatsApp": data.phone,
      "Email": data.email || undefined,
      "Nationalité": data.nationality || undefined,
      "Établissement actuel": data.school || undefined,
      "Niveau d'études souhaité en Malaisie": data.level || undefined,
      "Nom de la Formation souhaité": data.program || undefined,
      "Période de rentrée souhaitée": data.intakePeriod || undefined,
      "Année de rentrée": data.intakeYear || undefined,
      "Source": data.source || undefined,
      "Stage": "Enquiry",
    };

    if (data.ref) {
      fields["Code parrain utilisé"] = data.ref;
    }

    Object.keys(fields).forEach(k => fields[k] === undefined && delete fields[k]);

    const airtableRes = await fetch(
      `https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/${encodeURIComponent(AIRTABLE_TABLE_NAME)}`,
      {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${AIRTABLE_TOKEN}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ fields, typecast: true }),
      }
    );

    if (!airtableRes.ok) {
      const errText = await airtableRes.text();
      return new Response(JSON.stringify({ error: "Airtable submission failed", detail: errText }), { status: 500 });
    }

    return new Response(JSON.stringify({ success: true }), {
      status: 200,
      headers: { "Content-Type": "application/json" }
    });

  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), { status: 500 });
  }
}

// ---------- Full form (dossier complet) — updates existing student if phone matches ----------
async function handleFullSubmit(request, env) {
  try {
    const data = await request.json();

    if (!data.fullName || !data.phone) {
      return new Response(JSON.stringify({ error: "Missing required fields" }), { status: 400 });
    }

    const AIRTABLE_TOKEN = env.AIRTABLE_TOKEN;
    const AIRTABLE_BASE_ID = env.AIRTABLE_BASE_ID;
    const AIRTABLE_TABLE_NAME = env.AIRTABLE_TABLE_NAME || "STUDENTS";

    const phoneKey = normalizePhone(data.phone);
    const base = `https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/${encodeURIComponent(AIRTABLE_TABLE_NAME)}`;
    const headers = {
      "Authorization": `Bearer ${AIRTABLE_TOKEN}`,
      "Content-Type": "application/json",
    };

    // Look for an existing student with this phone (last 8 digits)
    const filterFormula = encodeURIComponent(`{Phone Match Key} = '${phoneKey}'`);
    const searchRes = await fetch(`${base}?filterByFormula=${filterFormula}&maxRecords=1`, {
      headers: { "Authorization": `Bearer ${AIRTABLE_TOKEN}` }
    });
    const searchData = await searchRes.json();
    const existingRecord = searchData.records && searchData.records[0];

    // Field names below match the STUDENTS table exactly; keys on the left match full-form.html's payload
    const fields = {
      "Nom et prénom": data.fullName,
      "Numéro WhatsApp": data.phone,
      "Email": data.email || undefined,
      "Numéro de passeport": data.passportNumber || undefined,
      "Date de naissance": data.dob || undefined,
      "Sexe": data.sex || undefined,
      "Lieu de naissance": data.birthPlace || undefined,
      "Nationalité": data.nationality || undefined,
      "État civil": data.maritalStatus || undefined,
      "Religion": data.religion || undefined,
      "Adresse complète": data.address || undefined,
      "Niveau d'études souhaité en Malaisie": data.level || undefined,
      "Nom de la Formation souhaité": data.program || undefined,
      "Période de rentrée souhaitée": data.intakePeriod || undefined,
      "Année de rentrée": data.intakeYear || undefined,
      "Nom du lycée": data.highSchool || undefined,
      "Diplôme obtenu (lycée)": data.highSchoolDiploma || undefined,
      "Nom de l'université": data.university || undefined,
      "Diplôme obtenu (université)": data.universityDiploma || undefined,
      "Nom du contact d'urgence": data.emName || undefined,
      "WhatsApp du contact d'urgence": data.emPhone || undefined,
      "Email du contact d'urgence": data.emEmail || undefined,
      "Numéro CNI/Passeport du contact d'urgence": data.emIdNumber || undefined,
      "Profession du contact d'urgence": data.emProfession || undefined,
      "Adresse du contact d'urgence": data.emAddress || undefined,
    };
    Object.keys(fields).forEach(k => fields[k] === undefined && delete fields[k]);

    let airtableRes;
    if (existingRecord) {
      // Update the existing record instead of creating a duplicate
      airtableRes = await fetch(`${base}/${existingRecord.id}`, {
        method: "PATCH",
        headers,
        body: JSON.stringify({ fields, typecast: true }),
      });
    } else {
      // No match found — student filled the full form without the short form first
      fields["Stage"] = "Enquiry";
      airtableRes = await fetch(base, {
        method: "POST",
        headers,
        body: JSON.stringify({ fields, typecast: true }),
      });
    }

    if (!airtableRes.ok) {
      const errText = await airtableRes.text();
      return new Response(JSON.stringify({ error: "Airtable submission failed", detail: errText }), { status: 500 });
    }

    return new Response(JSON.stringify({ success: true, matched: !!existingRecord }), {
      status: 200,
      headers: { "Content-Type": "application/json" }
    });

  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), { status: 500 });
  }
}


// ======================================================================
// Document upload (contact.edupremiere.com/documents)
// Files go to R2 (bucket edupremiere-uploads) + a DOCUMENTS row in Airtable.
// A Google Apps Script (runs as Pierre) pulls pending files every 10 min,
// saves them into the student's Drive folder, then calls /api/doc-stored.
// ======================================================================
const MAX_UPLOAD = 95 * 1024 * 1024;     // Workers request body limit is 100 MB
const MAX_FILES_PER_DAY = 30;
const DOCS_TABLE = "DOCUMENTS";

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json" } });
}

async function findStudentByPhone(env, phone) {
  const key = normalizePhone(phone);
  if (key.length < 8) return null;
  const base = `https://api.airtable.com/v0/${env.AIRTABLE_BASE_ID}/${encodeURIComponent(env.AIRTABLE_TABLE_NAME || "STUDENTS")}`;
  const f = encodeURIComponent(`{Phone Match Key} = '${key}'`);
  const fields = ["Nom et prénom", "Documents manquants", "Google Drive Folder"].map(x => `fields[]=${encodeURIComponent(x)}`).join("&");
  const r = await fetch(`${base}?filterByFormula=${f}&maxRecords=1&${fields}`, {
    headers: { "Authorization": `Bearer ${env.AIRTABLE_TOKEN}` }
  });
  const d = await r.json();
  return (d.records && d.records[0]) || null;
}

function missingList(rec) {
  const raw = (rec.fields["Documents manquants"] || "").toString();
  if (!raw || raw === "Niveau non renseigné") return [];
  return raw.split("\n").map(x => x.replace(/^•\s*/, "").trim()).filter(Boolean);
}

async function docLookup(request, env) {
  try {
    const { phone } = await request.json();
    const rec = await findStudentByPhone(env, phone);
    if (!rec) return json({ found: false });
    const name = (rec.fields["Nom et prénom"] || "").trim();
    return json({ found: true, firstName: name.split(/\s+/)[0] || "", missing: missingList(rec) });
  } catch (e) {
    return json({ error: e.message }, 500);
  }
}

function airtableDocType(t) {
  if (!t) return null;
  if (t.startsWith("Passeport")) return "Passeport (toutes pages)";
  if (t.startsWith("Diplôme de Master / attestation de réussite (EN)")) return "Diplôme de Master / attestation de réussite (EN) ";
  if (t === "Autre") return null;
  return t;
}

async function docUpload(request, env) {
  try {
    const url = new URL(request.url);
    const phone = url.searchParams.get("phone") || "";
    const type = url.searchParams.get("type") || "Autre";
    const name = (url.searchParams.get("name") || "document").replace(/[^\p{L}\p{N}._ ()-]/gu, "_").slice(0, 120);
    const size = parseInt(request.headers.get("Content-Length") || "0", 10);
    if (!size) return json({ error: "empty" }, 400);
    if (size > MAX_UPLOAD) return json({ error: "too_large" }, 413);

    const rec = await findStudentByPhone(env, phone);
    if (!rec) return json({ error: "unknown_phone" }, 403);

    const day = new Date().toISOString().slice(0, 10);
    const prefix = `${rec.id}/${day}/`;
    const existing = await env.UPLOADS.list({ prefix, limit: MAX_FILES_PER_DAY + 1 });
    if (existing.objects.length >= MAX_FILES_PER_DAY) return json({ error: "daily_limit" }, 429);

    const studentName = (rec.fields["Nom et prénom"] || "").trim();
    const docType = airtableDocType(type);

    // 1) DOCUMENTS row
    const docsBase = `https://api.airtable.com/v0/${env.AIRTABLE_BASE_ID}/${encodeURIComponent(DOCS_TABLE)}`;
    const fields = {
      "Student": [rec.id],
      "Status": "Received – to check",
      "Notes": `Uploaded by the student via the documents page on ${day} — file: ${name} (${(size / 1048576).toFixed(1)} MB). Waiting for transfer to Drive.`,
    };
    if (docType) fields["Document Type"] = docType;
    const cr = await fetch(docsBase, {
      method: "POST",
      headers: { "Authorization": `Bearer ${env.AIRTABLE_TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify({ fields, typecast: true }),
    });
    if (!cr.ok) return json({ error: "airtable", detail: await cr.text() }, 500);
    const docRow = await cr.json();

    // 2) File -> R2 (streamed)
    const key = `${prefix}${Date.now()}-${name}`;
    await env.UPLOADS.put(key, request.body, {
      httpMetadata: { contentType: request.headers.get("Content-Type") || "application/octet-stream" },
      customMetadata: {
        docRowId: docRow.id, studentId: rec.id, studentName,
        folderUrl: rec.fields["Google Drive Folder"] || "", type, originalName: name, size: String(size),
      },
    });
    return json({ ok: true });
  } catch (e) {
    return json({ error: e.message }, 500);
  }
}

function authorized(request, env) {
  return env.UPLOAD_SECRET && request.headers.get("X-Upload-Secret") === env.UPLOAD_SECRET;
}

async function docPending(request, env) {
  if (!authorized(request, env)) return json({ error: "forbidden" }, 403);
  const out = [];
  let cursor;
  do {
    const page = await env.UPLOADS.list({ cursor, limit: 500, include: ["customMetadata"] });
    for (const o of page.objects) out.push({ key: o.key, size: o.size, ...(o.customMetadata || {}) });
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor && out.length < 200);
  return json({ files: out });
}

async function docFile(request, env) {
  if (!authorized(request, env)) return json({ error: "forbidden" }, 403);
  const key = new URL(request.url).searchParams.get("key");
  const m = (request.headers.get("Range") || "").match(/bytes=(\d+)-(\d+)/);
  const opts = m ? { range: { offset: +m[1], length: +m[2] - +m[1] + 1 } } : {};
  const obj = await env.UPLOADS.get(key, opts);
  if (!obj) return json({ error: "not_found" }, 404);
  return new Response(obj.body, { status: m ? 206 : 200, headers: { "Content-Type": "application/octet-stream" } });
}

async function docStored(request, env) {
  if (!authorized(request, env)) return json({ error: "forbidden" }, 403);
  const { key, docRowId, driveFileId } = await request.json();
  const docsBase = `https://api.airtable.com/v0/${env.AIRTABLE_BASE_ID}/${encodeURIComponent(DOCS_TABLE)}`;
  const obj = await env.UPLOADS.head(key);
  const meta = (obj && obj.customMetadata) || {};
  const up = await fetch(`${docsBase}/${docRowId}`, {
    method: "PATCH",
    headers: { "Authorization": `Bearer ${env.AIRTABLE_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({ fields: {
      "Lien Drive": `https://drive.google.com/file/d/${driveFileId}/view`,
      "Notes": `Uploaded by the student via the documents page — original file: ${meta.originalName || ""}. Saved in Drive, to be renamed/checked.`,
    } }),
  });
  if (!up.ok) return json({ error: "airtable", detail: await up.text() }, 500);
  await env.UPLOADS.delete(key);
  return json({ ok: true });
}
