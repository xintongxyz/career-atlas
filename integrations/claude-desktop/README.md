# Career Atlas — Claude Desktop extension

Lets Claude Desktop send a job it researched to your **local** Career Atlas as a **draft**. You review the draft in Career Atlas and click **Save**; nothing is stored before that.

- Tools: `create_job_draft` (creates a draft) and `check_job_url` (answers only "already saved: yes/no").
- Talks only to Career Atlas on this computer (`http://127.0.0.1:4310` by default). No file, shell or database access; it cannot read, edit or delete your jobs.
- Uses your normal Claude Desktop chat. No API key, no extra billing.

## Install
1. Build the bundle: `npm run mcp:pack` → `dist/career-atlas.mcpb`.
2. Claude Desktop → Settings → Extensions → Advanced settings → **Install Extension…** → choose `dist/career-atlas.mcpb` → Install.
3. Keep Career Atlas open (the launcher or `npm run start:local`).

## Use
In a Claude Desktop chat: *"Add this job to Career Atlas: <job link or pasted description>"*. Claude asks permission to use the tool, creates the draft, and the review page opens in your browser.

Claude also sends English and Simplified Chinese versions of the descriptive fields in the same call; Career Atlas stores them on the same job and shows them when you switch language (display only, never evidence).

Every value is labelled: **Verified in posting** (an exact quote was found in the job description), **From the web** (another page, linked), or **AI inference** (Claude's judgment). Salary, visa, work authorization, eligibility, work arrangement and deadlines are only accepted with a verified quote.
