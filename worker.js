export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname === "/api/submit" && request.method === "POST") {
      return handleSubmit(request, env);
    }

    if (url.pathname === "/api/submit-full" && request.method === "POST") {
      return handleFullSubmit(request, env);
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
      "Niveau d'études souhaité en Malaisie": data.level || undefined,
      "Nom de la Formation souhaité": data.program || undefined,
      "Année de rentrée": data.intake || undefined,
      "Source": data.source || undefined,
      "Stage": "Enquiry",
    };

    if (data.ref) {
      fields["Numéro de Parrainage"] = data.ref;
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
