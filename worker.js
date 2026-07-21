export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname === "/api/submit" && request.method === "POST") {
      return handleSubmit(request, env);
    }

    // Everything else: serve the static files (index.html, logo.jpg, etc.)
    return env.ASSETS.fetch(request);
  }
};

async function handleSubmit(request, env) {
  try {
    const data = await request.json();

    if (!data.fullName || !data.phone) {
      return new Response(JSON.stringify({ error: "Missing required fields" }), { status: 400 });
    }

    const AIRTABLE_TOKEN = env.AIRTABLE_TOKEN;
    const AIRTABLE_BASE_ID = env.AIRTABLE_BASE_ID;
    const AIRTABLE_TABLE_NAME = env.AIRTABLE_TABLE_NAME || "STUDENTS";

    // IMPORTANT: these keys must match your exact Airtable column names
    const fields = {
      "Full Name": data.fullName,
      "Phone Number": data.phone,
      "Email": data.email || undefined,
      "Nationality": data.nationality || undefined,
      "Program Level": data.level || undefined,
      "Program Interested": data.program || undefined,
      "Année de rentrée": data.intake || undefined,
      "Source": data.source || undefined,
      "Stage": "Enquiry",
      "Form Type Submitted": ["Short"],
    };

    if (data.ref) {
      fields["Referral Code Used"] = data.ref;
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
