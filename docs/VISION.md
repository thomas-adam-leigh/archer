# Archer — Vision Document

Pause. Take a step back. Dream with me.

I want to build a mobile app — possibly paired with a web app that shares the same database. Here's the picture: anyone can download it, and the moment they sign up, they meet Archer.

## Onboarding

Archer walks each new user through onboarding. They tell Archer which jobs they want to apply for, upload their resume, and — most importantly — talk at length about whatever they want: what's missing from their resume, where they feel weak, the parts of their experience they'd like to explain in more depth, their honest gaps, anything at all. Every transcript is saved to the database, and the profile grows and matures with each one.

This phase is deliberately *not* a back-and-forth AI chat. No one reads what the AI says, so that isn't where the value lives. The value is in the instructions Archer gives, the activities it sets, and the encouragement it offers — the simple, repeated promise that the more you pour in, the better Archer becomes at helping you.

## Going live: the acceptance gate

OfferZen has a model where you complete your profile and then request to go live. I want something similar. After a user submits, we may take up to 24 hours to respond.

In that window, our prompts decide whether we actually know enough about the person to let them through. The criteria are based more on heart and intention than on anything else: How deeply did they go into their resume and experience? Was it genuine? Was it sincere? Was it human?

If the answer is yes, we accept them onto the platform. Acceptance means two things are true: Archer holds one to five job titles the user wants to apply for, and the profile is complete enough to actually run our automation on their behalf.

## Daily job collection

Once a user is in, Archer goes to work. Every weekday at 13:00, the pipeline searches the job boards in their country — starting with South Africa: pnet.co.za, careerjunction.co.za, careerjet.co.za, and totaljobs.co.za — for new postings under their chosen titles. It copies every new posting once per day and saves it to Supabase.

## The matching engine

Supabase does a lot of the work. A cron job runs every minute and does nothing unless there's a new record in the jobs table with a status of `new`.

I'm weighing two architectures here. In one, a cron runs every minute, cycling through the new job records and either dismissing them or shortlisting them. In the other, we run a query per user against the entire jobs database and skip anything that doesn't fit what they want or sits beyond their experience level. For now, the every-minute cron that walks the new records and sorts them is what I want to build.

Either way, the database moves on its own — through Postgres functions and triggers, or edge functions fired by inserts and updates. As records change state, jobs advance along a kanban board, surfacing the ones that are a good match. (For example: I'm a software developer with no C# experience, so any posting that mentions C# should be dismissed automatically.)

## Company enrichment

The moment a new job record is created, a matching company record is created with it. When a job is shortlisted — or marked `alternative_outreach` — that company record moves from `new` to `researching` to `enriched` (or `enrichment_failed`).

The point is to avoid spending tokens researching companies the user shouldn't apply to in the first place. Once a job clears that bar, we hand the company to an agent that uses its LinkedIn MCP tool and a Firecrawl web-search tool to research it, enriching the surrounding tables — the team, email addresses, locations, anything that helps us proactively reach out and signal real intent to work there.

## The cover-letter loop

When a job is shortlisted (or marked `alternative_outreach`) and its company is enriched, Archer reaches out to the user. It tells them about the opportunity, the company, and the board it was found on, then asks for a voicenote to build the cover letter from.

Here's how that feels from the phone. A notification arrives from Archer. The user opens the app and opens the note Archer wrote, which they can optionally play aloud with ElevenLabs Speech v3 — hearing Archer briefly talk through the opportunity, anything worth knowing about the company, and a suggestion for what to put in the cover letter. The user then records a voicenote saying what they want to convey, and Archer turns that into a cover letter.

From there it's a swipe. Swipe right to approve. Swipe left and the app immediately opens voice recording so the user can say what they didn't like; Archer returns to a processing state, produces a new draft, and shows it again. The loop repeats until the user swipes right — at which point Archer notifies them that it's now attempting to apply.

## Applying

The apply step is custom-built for each job board, since every board has its own HTML, CSS, and quirks. For a board like CareerJunction, applying means opening the saved job URL, clicking the apply button, pasting the cover letter, and clicking apply. This is custom-built as a CLI tool in Python, using Patchwright and a residential address through Decodo.

When applying redirects to an external site, we save that to the database under the right table and status. A Postgres function and trigger handle it: a new row in the external-application-forms table with a status of `pending` fires a webhook that tells the Claude Code agent on my server to open the URL in Chrome DevTools. Using its Archer MCP tool, the agent reads the candidate's resume, portfolio, and experience, fills in the form, and finishes by setting the status to `completed` / `success` / `applied`, or `failed`.

## Watching Archer work (AG-UI)

The mobile app has to handle this beautifully. I need to always see what my Archer is doing — *my* Archer specifically; it makes no sense for a user to watch anyone else's. I want to see the agent's actions as they happen, the same way Claude's research feature lets you watch a 15- or 20-minute task unfold: how long it's been running, whether it's wrapping up, whether it's writing the proposal. I want to build this on the AG-UI convention.

Worth a deep dive:

- https://docs.ag-ui.com/introduction
- https://docs.ag-ui.com/concepts/architecture
- https://docs.ag-ui.com/concepts/events
- https://docs.ag-ui.com/concepts/messages
- https://docs.ag-ui.com/concepts/state
- https://docs.ag-ui.com/concepts/interrupts
- https://docs.ag-ui.com/concepts/tools

## The execution model

We have to be careful about the database and table design. The foundation of this product is the idea of systems that perform tasks each day — tasks that can begin, be in progress, fail, or succeed.

I picture an API like Hono wrapped over `claude -p` (or the Claude Agents SDK), using my OAuth token rather than the API. Whenever a server-side agent has to act manually — taking an external link and filling it in with its Chrome DevTools MCP — it needs a custom MCP that gives it exactly the tools required: to pull information about the user and to update the status on the external site. It may also need details about the enriched company, since some application pages ask things like "why do you want to work for this company?", and it may need the cover letter we already generated.

## The monorepo and self-healing CLI

I'm picturing a monorepo in a single git repository, with CI/CD through GitHub Actions and Komodo. The CLI handles two jobs: scraping new postings and applying on the boards. Alongside it, Claude agents can update the CLI directly — using the Chrome DevTools MCP to learn the structure of a board and design CLI routes for new sites, or to repair routes that break when a site changes its HTML and CSS.

That repair should be automatic. When a collect job fails and we see it in the database, we trigger a webhook that tells an agent to investigate, and potentially to request a revision to the CLI followed by a rebuild and redeploy through the pipeline.

## Proposals and approvals

Bigger than that: agents can submit proposals to a table that I approve from an admin app — which could be a mobile app on my phone or a desktop app. A proposal might request a work session to map the collect path for Careerjet and write the code into the CLI, test that it works, then submit a second request to rebuild and redeploy to Komodo. Like everything else, an approved proposal carries a status through to `completed` / `success`, or `failure`.

---

It's a grand, ambitious project — but one I know we can build, as long as we're smart about it. What I need from you first is help drawing out the real terminology and the architecture I'm reaching for. Once that's clear, we can map the milestones and build it brick by brick.
