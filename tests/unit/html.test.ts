import { describe, expect, it } from "vitest";
import { detectAccessProblem, extractJsonLd, extractMeta, findJobPosting, htmlToText } from "../../src/server/extraction/html";
import { jobPostingToCandidates } from "../../src/server/extraction/jsonld";

const page = `<!doctype html><html lang="en"><head><title>Data Analyst | Acme Careers</title>
<meta property="og:site_name" content="Acme &amp; Co">
<script type="application/ld+json">{"@context":"https://schema.org","@graph":[{"@type":"Organization","name":"Acme"},{"@type":"JobPosting","title":"Data Analyst","datePosted":"2026-09-30","validThrough":"2026-11-15T23:59:00-05:00","employmentType":["FULL_TIME"],
"hiringOrganization":{"@type":"Organization","name":"Acme Corp","sameAs":"https://acme.example.com"},
"jobLocation":{"@type":"Place","address":{"@type":"PostalAddress","addressLocality":"Toronto","addressRegion":"ON","addressCountry":"CA"}},
"baseSalary":{"@type":"MonetaryAmount","currency":"CAD","value":{"@type":"QuantitativeValue","minValue":75000,"maxValue":90000,"unitText":"YEAR"}},
"description":"<p>Join our team.</p><h3>Responsibilities</h3><ul><li>Build dashboards</li><li>Write SQL</li></ul>"}]}</script>
<style>.x{color:red}</style><script>window.tracking=1</script></head>
<body><nav>Home Jobs</nav><main><h1>Data Analyst</h1><p>Join our team &mdash; we&#39;re growing.</p><ul><li>Build dashboards</li><li>Write SQL</li></ul></main><footer>© Acme</footer></body></html>`;

describe("html helpers", () => {
  it("converts HTML to structured text without scripts or chrome", () => {
    const text = htmlToText(page, { mainOnly: false });
    expect(text).toContain("Data Analyst");
    expect(text).toContain("• Build dashboards");
    expect(text).toContain("Join our team — we're growing.");
    expect(text).not.toContain("window.tracking");
    expect(text).not.toContain("color:red");
  });
  it("parses JSON-LD JobPosting inside @graph", () => {
    const jp = findJobPosting(extractJsonLd(page));
    expect(jp?.title).toBe("Data Analyst");
    const { fields, descriptionText } = jobPostingToCandidates(jp!);
    expect(fields.company_name?.value).toBe("Acme Corp");
    expect(fields.city?.value).toBe("Toronto");
    expect(fields.employment_type?.value).toBe("full_time");
    expect(fields.salary?.value).toMatchObject({ min: 75000, max: 90000, currency: "CAD", period: "annually", source: "employer" });
    expect(fields.salary?.source).toBe("json_ld");
    expect(descriptionText).toContain("• Write SQL");
  });
  it("reads meta tags", () => {
    const meta = extractMeta(page);
    expect(meta["og:site_name"]).toBe("Acme & Co");
    expect(meta["html:title"]).toBe("Data Analyst | Acme Careers");
    expect(meta["html:lang"]).toBe("en");
  });
  it("detects bot walls and JS-only shells", () => {
    expect(detectAccessProblem('<div class="cf-chl-widget">Verify you are human</div>', "Verify you are human")).toBe("bot_protection");
    expect(detectAccessProblem('<div id="root"></div><noscript>You need to enable JavaScript</noscript>', "")).toBe("dynamic_content");
    expect(detectAccessProblem(page, htmlToText(page))).toBeNull();
  });
});
