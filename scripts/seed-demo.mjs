#!/usr/bin/env node
// Seeds (or resets) SYNTHETIC demo data into a local SQLite database. All companies, people and
// jobs are fictional.
//
//   CAREER_ATLAS_INSTANCE=dev npm run local -- seed-demo        (the usual way; dev/test instances only)
//   node scripts/seed-demo.mjs --sqlite <file> --email <address on an example.* domain>
//
// Safety: refuses the personal data folder, non-example email addresses, and any database that
// contains a user other than the demo account.
import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const args = process.argv.slice(2);
const opt = (k) => (args.includes(k) ? args[args.indexOf(k) + 1] : undefined);
const sqlitePath = opt("--sqlite");
const email = opt("--email") ?? "dev@example.test";
if (!sqlitePath) {
  console.error("Usage: node scripts/seed-demo.mjs --sqlite <file> [--email demo@example.test]");
  process.exit(1);
}
if (!/@(example\.(com|org|net|test)|[a-z0-9.-]+\.example\.test)$/i.test(email)) {
  console.error("Refusing: demo data may only be seeded for an example.* address.");
  process.exit(1);
}
const personal = join(homedir(), "Library", "Application Support", "CareerAtlas");
let target = sqlitePath;
try {
  target = realpathSync(sqlitePath);
} catch {
  /* new file */
}
if (target.startsWith(personal) || sqlitePath.startsWith(personal)) {
  console.error("Refusing: never seed demo data into the personal Career Atlas database.");
  process.exit(1);
}

const DAY = 86_400_000;
const now = Date.now();
const ago = (d, h = 10) => now - d * DAY + (h - 12) * 3600_000;
let n = 0;
const id = (p) => `demo-${p}-${String(++n).padStart(4, "0")}`;
const q = (v) => (v === null || v === undefined ? "NULL" : typeof v === "number" ? String(v) : typeof v === "boolean" ? (v ? "1" : "0") : `'${String(v).replace(/'/g, "''")}'`);
const json = (v) => q(JSON.stringify(v));
const sql = [];
const userId = `demo-user-${email.split("@")[0]}`;

// Reset only this demo user's data (cascades through foreign keys).
sql.push(`DELETE FROM users WHERE email = ${q(email)};`);
sql.push(`INSERT INTO users (id, email, display_name, created_at, last_seen_at) VALUES (${q(userId)}, ${q(email)}, 'Demo User', ${now}, ${now});`);
sql.push(
  `INSERT INTO user_preferences (user_id, locale, timezone, default_follow_up_days, comparison_json, updated_at) VALUES (${q(userId)}, 'en', 'America/Toronto', 7, ${json({
    preferred_work_modes: ["hybrid", "remote"],
    preferred_cities: ["Toronto", "Waterloo"],
    min_salary: 75000,
    min_salary_currency: "CAD",
    min_salary_period: "annually",
    preferred_categories: ["Data", "Analytics"],
    preferred_employment_types: ["full_time"],
    weights: { work_mode: 3, location: 2, salary: 3, category: 2, employment_type: 2 },
  })}, ${now});`,
);

const companies = {
  northwind: ["Northwind Analytics", "https://northwind.example.com", "Software"],
  maple: ["Maple Leaf Robotics", "https://mapleleafrobotics.example.com", "Robotics"],
  harbor: ["Harbor & Pine Insurance", "https://harborpine.example.com", "Insurance"],
  aurora: ["Aurora Health Labs", "https://aurorahealth.example.com", "Healthcare"],
  lumen: ["Lumen Transit Systems", "https://lumentransit.example.com", "Transportation"],
  cedar: ["Cedar Ledger Bank", "https://cedarledger.example.com", "Financial services"],
};
const companyIds = {};
for (const [key, [name, website, industry]] of Object.entries(companies)) {
  const cid = id("co");
  companyIds[key] = cid;
  const domain = new URL(website).hostname;
  sql.push(
    `INSERT INTO companies (id, user_id, name, normalized_name, website, domain, industry, created_at, updated_at) VALUES (${q(cid)}, ${q(userId)}, ${q(name)}, ${q(name.toLowerCase())}, ${q(website)}, ${q(domain)}, ${q(industry)}, ${ago(40)}, ${ago(40)});`,
  );
}

const jobs = [
  { co: "northwind", title: "Data Analyst", city: "Toronto", region: "ON", mode: "hybrid", freq: "3 days per week in office", sal: [72000, 86000, "CAD", "annually"], cat: "Data", saved: 21, flow: [["applied", 18], ["awaiting_response", 17], ["interview", 9]], priority: "high", tags: ["SQL", "Top pick"] },
  { co: "maple", title: "Business Intelligence Analyst", city: "Waterloo", region: "ON", mode: "onsite", sal: [68000, 80000, "CAD", "annually"], cat: "Analytics", saved: 30, flow: [["applied", 27], ["rejected", 12]], priority: "medium", tags: ["Power BI"] },
  { co: "harbor", title: "Junior Data Scientist", city: "Toronto", region: "ON", mode: "remote", regions: ["Canada"], sal: null, cat: "Data", saved: 12, flow: [["applied", 10]], priority: "medium", tags: ["Python"], auth: "Must be legally authorized to work in Canada." },
  { co: "aurora", title: "Healthcare Data Analyst", city: "Ottawa", region: "ON", mode: "hybrid", sal: [36, 42, "CAD", "hourly"], cat: "Data", saved: 8, flow: [["preparing", 6]], priority: "high", tags: ["SQL"], deadline: 9 },
  { co: "lumen", title: "Operations Analyst", city: "Vancouver", region: "BC", mode: "hybrid", sal: [70000, 82000, "CAD", "annually"], cat: "Operations", saved: 5, flow: [], priority: "low", tags: [] },
  { co: "cedar", title: "Risk Analytics Associate", city: "Toronto", region: "ON", mode: "onsite", sal: [80000, 95000, "CAD", "annually"], cat: "Analytics", saved: 35, flow: [["applied", 33], ["assessment", 26], ["interview", 19], ["offer", 6]], priority: "high", tags: ["Finance"], clearance: null },
  { co: "northwind", title: "Analytics Engineer", city: "Toronto", region: "ON", mode: "hybrid", sal: [90000, 110000, "CAD", "annually"], cat: "Data", saved: 3, flow: [], priority: null, tags: ["dbt"] },
  { co: "maple", title: "Data Engineering Intern", city: "Waterloo", region: "ON", mode: "onsite", type: "internship", sal: [25, 28, "CAD", "hourly"], cat: "Data", saved: 45, flow: [["applied", 44], ["withdrawn", 30]], priority: "low", tags: [] },
];

const STATUS_APP = new Set(["applied", "awaiting_response", "assessment", "interview", "offer", "accepted", "rejected", "withdrawn", "closed"]);
const tagIds = {};
for (const j of jobs) {
  const pid = id("post");
  const sid = id("saved");
  const savedAt = ago(j.saved);
  const desc = `${j.title}\n${companies[j.co][0]} — ${j.city}, ${j.region}\n\nAbout the role\nThis is a fictional demo posting. You will turn data into decisions for our ${j.cat.toLowerCase()} team.\n\nResponsibilities:\n• Build and maintain dashboards\n• Write SQL to answer business questions\n• Present findings to stakeholders\n\nRequirements:\n• 2+ years of experience in analytics\n• Strong SQL skills\n${j.auth ? `• ${j.auth}\n` : ""}\nNice to have:\n• Python or R\n`;
  sql.push(
    `INSERT INTO job_postings (id, user_id, company_id, original_url, canonical_url, source_platform, title, category, employment_type, posting_status, work_mode, city, region, country, remote_eligible_regions, hybrid_frequency, salary_min, salary_max, salary_currency, salary_period, salary_source, description_text, responsibilities, required_qualifications, preferred_qualifications, technical_skills, work_authorization, deadline_at, extraction_status, created_at, updated_at) VALUES (` +
      [
        q(pid),
        q(userId),
        q(companyIds[j.co]),
        q(`https://careers.${new URL(companies[j.co][1]).hostname}/jobs/${pid}`),
        q(`https://careers.${new URL(companies[j.co][1]).hostname}/jobs/${pid}`),
        q("company_site"),
        q(j.title),
        q(j.cat),
        q(j.type ?? "full_time"),
        q(j.flow.at(-1)?.[0] === "closed" ? "closed" : "open"),
        q(j.mode),
        q(j.city),
        q(j.region),
        q("Canada"),
        j.regions ? json(j.regions) : "NULL",
        q(j.freq ?? null),
        j.sal ? j.sal[0] : "NULL",
        j.sal ? j.sal[1] : "NULL",
        q(j.sal ? j.sal[2] : null),
        q(j.sal ? j.sal[3] : "unknown"),
        q(j.sal ? "employer" : "unknown"),
        q(desc),
        json(["Build and maintain dashboards", "Write SQL to answer business questions", "Present findings to stakeholders"]),
        json(["2+ years of experience in analytics", "Strong SQL skills", ...(j.auth ? [j.auth] : [])]),
        json(["Python or R"]),
        json(["SQL", "Python", "Tableau"]),
        q(j.auth ?? null),
        j.deadline ? now + j.deadline * DAY : "NULL",
        q("none"),
        savedAt,
        savedAt,
      ].join(", ") +
      `);`,
  );
  const preStage = j.flow.find(([s]) => !STATUS_APP.has(s))?.[0] ?? "saved";
  const last = j.flow.length ? ago(j.flow.at(-1)[1]) : savedAt;
  sql.push(
    `INSERT INTO saved_jobs (id, user_id, job_posting_id, stage, is_starred, priority, saved_at, last_activity_at, updated_at) VALUES (${q(sid)}, ${q(userId)}, ${q(pid)}, ${q(preStage)}, ${j.priority === "high" ? 1 : 0}, ${q(j.priority)}, ${savedAt}, ${last}, ${last});`,
  );
  sql.push(`INSERT INTO application_events (id, user_id, saved_job_id, type, to_status, occurred_at, created_at) VALUES (${q(id("ev"))}, ${q(userId)}, ${q(sid)}, 'job_saved', 'saved', ${savedAt}, ${savedAt});`);

  const appFlow = j.flow.filter(([s]) => STATUS_APP.has(s));
  if (appFlow.length) {
    const aid = id("app");
    const appliedAt = ago(appFlow[0][1]);
    const reached = (s) => appFlow.find(([x]) => x === s);
    const status = appFlow.at(-1)[0];
    const firstResp = appFlow.find(([s]) => ["assessment", "interview", "offer", "accepted", "rejected"].includes(s));
    const terminal = ["accepted", "rejected", "withdrawn", "closed"].includes(status);
    sql.push(
      `INSERT INTO applications (id, user_id, saved_job_id, job_posting_id, status, applied_at, applied_via, last_activity_at, first_response_at, last_response_at, reached_assessment_at, reached_interview_at, reached_offer_at, final_outcome_at, next_follow_up_at, offer_deadline_at, created_at, updated_at) VALUES (` +
        [
          q(aid),
          q(userId),
          q(sid),
          q(pid),
          q(status),
          appliedAt,
          q("Company website"),
          last,
          firstResp ? ago(firstResp[1]) : "NULL",
          firstResp ? ago(firstResp[1]) : "NULL",
          reached("assessment") ? ago(reached("assessment")[1]) : "NULL",
          reached("interview") ? ago(reached("interview")[1]) : "NULL",
          reached("offer") ? ago(reached("offer")[1]) : "NULL",
          terminal ? last : "NULL",
          terminal ? "NULL" : appliedAt + 7 * DAY,
          status === "offer" ? now + 5 * DAY : "NULL",
          appliedAt,
          last,
        ].join(", ") +
        `);`,
    );
    let prev = preStage === "preparing" ? "preparing" : "saved";
    for (const [s, d] of appFlow) {
      const type = s === "applied" ? "application_submitted" : "status_changed";
      sql.push(
        `INSERT INTO application_events (id, user_id, saved_job_id, application_id, type, from_status, to_status, occurred_at, created_at) VALUES (${q(id("ev"))}, ${q(userId)}, ${q(sid)}, ${q(aid)}, ${q(type)}, ${q(prev)}, ${q(s)}, ${ago(d)}, ${ago(d)});`,
      );
      prev = s;
    }
    if (!terminal) {
      sql.push(
        `INSERT INTO reminders (id, user_id, saved_job_id, kind, title, due_at, auto_key, created_at, updated_at) VALUES (${q(id("rem"))}, ${q(userId)}, ${q(sid)}, 'follow_up', 'follow_up_default', ${appliedAt + 7 * DAY}, ${q(`follow_up:${aid}`)}, ${appliedAt}, ${appliedAt});`,
      );
    }
    if (status === "interview") {
      sql.push(
        `INSERT INTO reminders (id, user_id, saved_job_id, kind, title, due_at, created_at, updated_at) VALUES (${q(id("rem"))}, ${q(userId)}, ${q(sid)}, 'interview', 'Panel interview with the analytics team', ${now + 2 * DAY + 3 * 3600_000}, ${now}, ${now});`,
      );
    }
  } else if (preStage !== "saved") {
    sql.push(
      `INSERT INTO application_events (id, user_id, saved_job_id, type, from_status, to_status, occurred_at, created_at) VALUES (${q(id("ev"))}, ${q(userId)}, ${q(sid)}, 'status_changed', 'saved', ${q(preStage)}, ${ago(j.flow[0][1])}, ${ago(j.flow[0][1])});`,
    );
  }
  for (const tag of j.tags) {
    if (!tagIds[tag]) {
      tagIds[tag] = id("tag");
      sql.push(`INSERT INTO tags (id, user_id, name, normalized_name, created_at) VALUES (${q(tagIds[tag])}, ${q(userId)}, ${q(tag)}, ${q(tag.toLowerCase())}, ${now});`);
    }
    sql.push(`INSERT INTO job_tags (saved_job_id, tag_id, created_at) VALUES (${q(sid)}, ${q(tagIds[tag])}, ${now});`);
  }
  if (j.title === "Data Analyst") {
    sql.push(`INSERT INTO notes (id, user_id, saved_job_id, body, created_at, updated_at) VALUES (${q(id("note"))}, ${q(userId)}, ${q(sid)}, 'Recruiter mentioned the team is growing. Prepare a dashboard walkthrough for the panel.', ${ago(9)}, ${ago(9)});`);
  }
}
sql.push(
  `INSERT INTO contacts (id, user_id, company_id, name, kind, title, email, created_at, updated_at) VALUES (${q(id("ct"))}, ${q(userId)}, ${q(companyIds.northwind)}, 'Jordan Rivera', 'recruiter', 'Talent Partner', 'jordan.rivera@northwind.example.com', ${now}, ${now});`,
);

{
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(sqlitePath);
  db.exec("PRAGMA foreign_keys = ON");
  const others = db.prepare("SELECT email FROM users WHERE email <> ?").all(email);
  if (others.length) {
    console.error(`Refusing: the target database contains ${others.length} other user account(s).`);
    process.exit(1);
  }
  db.exec("BEGIN");
  try {
    db.exec(sql.join("\n"));
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
  db.close();
  console.log(`✓ Seeded ${jobs.length} fictional jobs for ${email}.`);
  process.exit(0);
}

