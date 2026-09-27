<!-- platform-version: 1 -->

# Building a BibleProject vibe app

You're building a **vibe app** — a small self-contained tool that BibleProject staff host on the
internal vibe-apps platform. This file tells you the rules of that platform so what you build
actually deploys and runs. Read it before you start.

## What this platform is

- Your app is a **static site**. It's served from S3 behind CloudFront at
  `https://bp-vibes.com/<slug>/` (staging/dev use `https://<env>.bp-vibes.com/<slug>/`).
- **There is no server and no build step on the platform.** Whatever you produce — HTML, CSS, JS,
  assets — is uploaded as-is and served as static files. If you need a build (bundler, framework),
  run it yourself and deploy the *built output*.
- Every visitor is an authenticated BibleProject user (access is enforced at the CDN edge before
  the page loads), unless the app owner turns on **kiosk mode** (then anonymous office-network
  users can reach it too).
- You get a **database** and **file storage** through platform APIs. You do not get to run server
  code — but you don't need to for storing data.

## Hard requirements (deploys are rejected otherwise)

1. **`index.html` must be at the root of what you deploy.** You upload a `.zip`; `index.html` has to
   sit at the top level of it. (A single wrapping folder is automatically stripped, so a zip
   containing just `my-app/index.html` is fine — but nothing deeper.)
2. **Only these file types are allowed.** Anything else — including files with no extension — makes
   the whole deploy fail:
   ```
   html htm css js mjs map json xml txt md
   svg png jpg jpeg gif webp avif ico bmp
   woff woff2 ttf otf eot wasm webmanifest pdf csv thumbnail
   ```
   No `.env`, no server code, no `.py`, no binaries. Reference everything with **relative paths**,
   or with the `/_shared/...` absolute paths described below.
3. **No secrets in your code.** Everything you ship is downloadable by the browser. Every deploy is
   scanned (gitleaks): a high-risk secret (API key, private key, token) **hard-blocks** the deploy;
   lower-risk matches need an admin to approve. Don't embed credentials.
4. **Size limits.** One upload must be ≤ **200 MB**, and the app's total retained versions must stay
   under its **1 GB** storage quota (both admin-tunable per app). Over quota → deploy blocked; the
   user is prompted to delete old versions on the app's detail page to free space. Never
   automatically delete anything without direct user prompting, and even then confirm first.

## Your app's manifest: `vibes.json`

Every app has a small `vibes.json` at the root of what it deploys. The platform reads it when you
deploy — before your app runs — so anything declared here is visible to the app's owner and can be
reviewed rather than discovered later.

```json
{
  "platform": 1,
  "collections": {
    "tasks":  { "access": "owner"  },
    "boards": { "access": "shared" }
  }
}
```

- `platform` — which version of the platform this app was built against. See "Keeping this app
  current".
- `collections` — every data collection the app uses and **who is allowed to read it**. This is the
  whole privacy model for your data, which is why it lives in a reviewable file instead of a line of
  JavaScript. See "Storing data".

A collection you use but forget to declare defaults to `owner` (private per user). Safe, but it
means shared features silently won't work — declare what you use.

## Keeping this app current

The platform changes. When it does, this file and the APIs it describes change with it — and an app
built against an older version may need small updates.

At the start of a session, check `/_shared/platform/version.json` against the `platform` value in
`vibes.json`. If it's behind, there are pending migrations at `/_shared/platform/migrations/<n>.md`.

Use those paths **relative**, never with a hostname. Each environment publishes its own copy, and a
relative path resolves to the one this app is actually running against. Hardcoding
`https://bp-vibes.com/...` would compare a dev or staging app against production's contract and
report it as behind when it isn't.

**Talk about how far behind the app is, never about version numbers.** Say "there have been two
updates since this app was built" — not "you're on platform v1". The number is plumbing; the author
shouldn't have to know or care what it means.

**Always ask before applying them. Never update the app silently, and never hold up what the user
actually asked for.**

When to ask:

- **Any pending migration marked `required`** — ask first. Something in the app no longer works, and
  building on it wastes everyone's time.
- **All `informational`** — do what the user asked, *then* offer at the end.

Ask briefly, and make declining easy:

> The bp-vibes platform has had 2 updates since this app was built — mostly new features you could
> use. Want me to bring the app up to date while I'm here?
>
> **yes** · **no, just move the button** · **tell me more**

Make the "no" option name the thing they actually asked for, so it's obviously the low-friction path
and not a scary-sounding refusal.

If they pick **tell me more**, read them the `Summary` from each pending migration and say what it
would mean for *this* app specifically — a few plain sentences, no jargon, no code. Then ask again.

If they say **no**, do what they asked and don't raise it again this session.

If they say **yes**, apply each migration in order, oldest first — an app that has missed several
updates catches up by working through them one at a time. Each migration says when to skip it
because the app already does the right thing. Then update `platform` in `vibes.json` and the
`platform-version` marker at the top of this file.

If the app's `platform` is *higher* than `current`, do nothing — that can happen after a platform
rollback, and it's harmless. Never downgrade an app.

The app's page in HAL shows the same thing and offers the author a line to paste here:
**"Bring this app up to date with the bp-vibes platform."** Treat that as an explicit yes — they've
already decided, so don't ask again, just do it and tell them what changed.

## Your app runs inside an iframe

The URL a user visits — `bp-vibes.com/<slug>/` — serves a small shell page that frames your app
from its own dedicated origin. **This is what gives your app a real identity**, so the platform can
tell your app apart from every other app when you call its APIs.

Practical consequences, all of which you must design for:

- **Never framebust.** No `top.location = …`, no `if (window.top !== window.self)` escapes. Your app
  will simply break.
- **Your URL is not the user's URL.** The address bar shows the page around your app, not your
  frame — so a URL you set inside your app is not something the user can bookmark or share.
  Deep linking isn't supported yet; keep shareable state out of your design for now.
- **Use hash or query routing, never path routing.** `#/items/42` and `?item=42` work. A path route
  like `/items/42` does not — it 404s on reload, and it did so before iframes too.
- **Size to the frame.** `100vh` / `100%` resolve to the frame, which is full-viewport. That works.
  Don't try to measure or reach the outer page.
- **`localStorage` is yours alone**, scoped to your app's origin. No other app can read it. It's
  per-browser and per-device — a user on a laptop and a phone sees two different sets. That's a
  feature for some things and a bug for others; see below.
- Clipboard writes, file downloads (`<a download>`), and popups all work normally.
- **Debugging: switch DevTools to your app's frame first.** The console and the `$0`/`$()` helpers
  default to the outer page, where none of your variables exist — so your own globals come back
  `undefined` and it looks like the app failed to load. Use the context dropdown at the top of the
  Console panel (it says `top`) and pick the `…apps.bp-vibes.com` entry. Network and Elements show
  every frame already; only the console needs switching.

### Signing in again

Sessions are short-lived, so an app left open will eventually find itself signed out. You don't
have to do anything for this: the storage client notices, and the page around your app sends the
user through sign-in and back. Your app reloads afterwards.

What that means for you is only this — **don't hold unsaved work in memory**. Save as the user
goes, or keep a copy in `localStorage` alongside what you've saved, so a reload never costs them
anything they typed.

If you want to say something first, every storage error carries `err.signedOut`:

```js
catch (err) {
  if (err.signedOut) showBanner('Signing you in again…');
}
```

**Deep links aren't available yet.** The address bar shows the page around your app, not your
app, so a URL you set inside your app isn't something the user can share. Keep state in your
app rather than in the URL for now. Hash and query routing still work *within* a session.

## Getting the current user

A shared, same-origin ES module lives at **`/_shared/auth.js`**. Import it directly (no bundling,
no copy — the platform provides it):

```js
import { loadPermissions, getFirstName, getEmail, getGroups, inGroup } from '/_shared/auth.js';
await loadPermissions();          // one fetch, populates the session
const name = getFirstName();      // "Jordan", or null if not signed in
```

API (all synchronous getters read the session that `loadPermissions()` fetched):

- `init()` — mark the session authenticated **without** a network call. Use when you only need
  "is someone signed in?" and don't need their details.
- `loadPermissions()` → `Promise` — fetch the current user once and cache them. `await` this before
  using the getters. On any error it resolves to an unauthenticated session (never throws).
- `isAuthenticated()` / `isAnonymous()` → boolean
- `getEmail()`, `getFirstName()`, `getLastName()`, `getFullName()`, `getDepartment()`,
  `getAvatarSm()` → string or `null`
- `getGroups()` → string[], `inGroup(name)` → boolean
- `getPermissions()` → string[], `hasPermission(perm)` → boolean

**Kiosk apps:** if kiosk mode is on, some visitors are anonymous (`isAuthenticated()` is false and
the getters return `null`/`[]`). Always handle that case gracefully.

## Storing data

Your app gets a **records store** — a database, scoped to your app, that no other app can write to.
Use it for anything that must survive a page reload, be visible on another device, or be shared
between users.

```js
import { records } from '/_shared/data.js';
```

### Which store — the browser or the records store

Both are correct tools. Neither replaces the other, and moving everything into the records store is
its own mistake — a theme toggle that takes a network round-trip is worse than one that doesn't, and
it counts against the app's storage quota for no benefit.

The line is **what the thing is about**:

| The thing is about… | Where it goes |
| --- | --- |
| this browser, on this machine | `localStorage` |
| the person, or the work they're doing | the records store |

Use `localStorage` for: theme, collapsed panels, the last tab someone had open, a dismissed tip,
which room a kiosk is in. All of it is fine to lose, and none of it should follow the user to
another device.

Use the records store for: anything someone typed, anything they'd be annoyed to lose, anything
they'd expect to see on their phone after entering it on a laptop, anything a second person needs
to read.

Three questions settle almost every case. If any answer is yes, it belongs in the records store:

1. Would someone be annoyed if this vanished?
2. Would they expect to see it on a different device?
3. Does anyone else need to read it?

**One legitimate overlap:** keeping a copy in `localStorage` of something you've already saved to
the records store — as a crash-safety net for a half-finished form, or to make a reload feel instant
while the real data loads. That's fine, and it's a good idea for a long form. The rule is that the
records store is the truth and the browser copy is disposable. Never the other way around: if the
only copy is in the browser, it isn't saved.

### Collections

Data lives in named **collections** — the equivalent of tables. You declare them in `vibes.json`
(see above), not in code. The client library uses collections; it never defines them.

**Collection names are lowercase.** Letters, digits, `-` and `_`, starting with a letter or digit:

```
burgers   blitz-scores   icon_positions        ✅
Burgers   blitzScores    2026-burgers          ❌ (last one is fine — it starts with a digit)
```

Not a style preference — a name with a capital in it is rejected. Use the same string in
`vibes.json` and in every `records`/`files` call; they must match exactly.

Record **keys** are separate and much freer — any string up to 128 characters, so
`records.put('burgers', 'id-abc123', …)` is fine whatever shape your ids take. Only the
*collection* name is constrained.

**Pick `access` deliberately, it is enforced by the server:**

| `access` | Who can read/write |
| --- | --- |
| `owner` | Only the person who saved each record. The default, and the safe choice. |
| `shared` | **Anyone signed in at BibleProject.** Use for genuinely shared state — a team board, a shared config. |
| `group:<name>` | Only members of that BibleProject group. Genuinely enforced, not a UI hint. |

When you explain `shared` to the app's owner, say **"anyone signed in at BibleProject"** — not "all
app users" or "shared". Any staff member can open any app, so those describe the same people, but
only one of them sounds like it does.

### Reading and writing records

```js
// Create or replace. `key` is yours to choose and unique within the collection.
await records.put('tasks', 'task-1', {
  data: { title: 'Ship the thing', done: false },
});

await records.get('tasks', 'task-1');        // one record, or null
await records.list('tasks');                 // all records you're allowed to see
await records.remove('tasks', 'task-1');

// When you have no natural key — an event log, a submission — let the server make one:
const saved = await records.add('events', { data: { kind: 'click' } });
saved.key;                                   // server-generated
```

`list()` also takes filters: `{ tag: 'active' }`, `{ mine: true }` (your own records only, useful in
a `shared` collection), and `{ limit, offset }` for paging. It returns at most 500 records.

Every record has these optional fields alongside `data`:

- `parent` — the **containing** record, written `'collection/key'`. Deleting the parent deletes its
  children.
- `refs` — named references to records that live independently, also `'collection/key'`:
  `{ assignee: 'people/user-3' }`. Deleting the referenced record does *not* delete this one.
- `tag` — a single indexed label for filtering (`'active'`, `'archived'`).
- `position` — an integer for user-ordered lists.

**Both relation fields name a record as `'collection/key'`, not a bare key.** A key is only unique
*within* its collection, so `'suite-1'` doesn't identify anything on its own — and a container often
lives in a different collection from the thing it contains. A malformed or dangling reference is
rejected when you write it, so you'll find out immediately rather than via a silently empty result
later.

### Relations

Use `parent` when a thing **belongs to** another thing and should die with it. Use `refs` when it
merely **points at** another thing.

```js
await records.put('cases',   'case-7',   { parent: 'suites/suite-1', data: { … } });
await records.put('results', 'result-9', {
  parent: 'runs/run-3',
  refs:   { case: 'cases/case-7' },
  data:   { … },
});
```

Then query either direction — both are indexed:

```js
await records.list('cases',   { parent: 'suites/suite-1' });        // cases in a suite
await records.list('results', { refs: { case: 'cases/case-7' } }); // results referencing a case
await records.list('tasks',   { tag: 'active' });
```

`refs` can hold as many names as you need, and a name may hold an array
(`{ tags: ['a', 'b'] }`) for many-to-many. Note that `refs` are not checked for you beyond
creation — if you delete a referenced record, references to it are left dangling, so handle a
missing target when you read.

**If a relation itself needs data** (a note on the link, an ordering within the link), make the
link its own record in its own collection, with `refs` pointing at both ends.

### Concurrent edits

If two people edit the same record, the second write is rejected rather than silently overwriting:

```js
try {
  await records.put('boards', 'board-1', { data: next });
} catch (err) {
  if (err.conflict) {
    // Someone else changed it first. Re-read, merge or prompt, then retry.
    const current = await records.get('boards', 'board-1');
  }
}
```

Handle `err.conflict` on any collection where two people might edit at once. Don't retry blindly in
a loop — you'll just overwrite their work more politely.

You never handle a version number yourself; the library tracks it. One consequence worth knowing:
writing to a record this page has never read **will** conflict. That's deliberate — replacing
something you haven't looked at is exactly the case this protects against. Read it first, or use a
key you know is new.

The other error worth naming is `err.full` — the app is out of storage. Tell the person and stop;
never delete their data to make room.

## Storing files

For user uploads — images, CSV, JSON, PDFs — your app gets file storage, again scoped to your app.

```js
import { files } from '/_shared/data.js';

const meta = await files.upload('photos', fileInput.files[0]);   // { key, name, size, contentType }
const url  = await files.url('photos', meta.key);                // short-lived URL
img.src = url;

await files.list('photos');
await files.remove('photos', meta.key);
```

- Files live in **collections** exactly like records, and obey the same `access` rules.
- `files.url()` returns a **short-lived** URL. Fetch it when you're about to use it; don't store it
  in a record or hard-code it — it expires.
- Store the `key` in a record if you want to associate a file with your data:
  `records.put('items', 'item-1', { data: { photo: meta.key } })`.
- Uploads are capped at **25 MB** per file and restricted to the same file types listed above.

## Quotas

Your app has a records quota and a files quota. When you hit one, **writes fail** — nothing is
deleted to make room. Surface the error to the user; the app owner frees space from the app's page
in HAL. Never quietly delete a user's data to stay under quota.

## Degrade, don't crash

**Everything the platform hands you can be unavailable, and your app must still work when it is.**
This is not defensive padding — each of these happens in normal use:

- The user is on a slow or dropped connection.
- Someone opens `index.html` straight off their disk, with no platform around it at all.
- An image, a file URL, or the auth module fails to load for a reason neither of you controls.
- A stored file's short-lived URL expired between fetching it and using it.

The rule: **decide what the app looks like without each piece, and build that first.** A tool that
shows slightly less is fine. A blank page is not, and it's what an unhandled failure gives you.

```js
// Auth: getters return null rather than throwing, but the import itself can fail.
let user = null;
try {
  const auth = await import('/_shared/auth.js');
  await auth.loadPermissions();
  user = auth.getFullName();
} catch { /* no platform (local preview, network) — carry on */ }
greeting.textContent = user ? `Hi ${user}` : 'Hi there';
```

```js
// Images, including the user's avatar: always have something to draw instead.
const img = new Image();
img.crossOrigin = 'anonymous';        // required if you read the pixels (canvas, WebGL)
img.onerror = () => drawPlaceholder();  // <- the important line
img.onload = () => drawAvatar(img);
img.src = avatarUrl;
```

That `onerror` is doing real work. Displaying an image with `<img src>` almost always succeeds, but
*reading its pixels* — drawing it to a canvas, using it as a texture — is a stricter operation that
can fail on its own. Write the fallback branch even when the image "obviously" loads.

```js
// Storage: a write can fail for reasons worth telling the user apart.
try {
  await records.put('boards', 'board-1', { data: next });
} catch (err) {
  if (err.conflict) { /* someone else changed it — re-read and merge */ }
  else if (err.full) { /* out of space — tell them, don't delete anything */ }
  else { /* offline or unknown — keep their work on screen, offer to retry */ }
}
```

Never discard what someone typed because a save failed. Keep it in front of them and let them try
again.

## Security — what's real and what isn't

Be precise about this, because two of these look similar and aren't:

- **Server-enforced (trust it):** collection `access` rules. `owner` really does hide other users'
  records; `group:<name>` really does check membership. The server decides, using the signed-in
  user's identity — not anything your code sends.
- **UI convenience only (do not trust it):** `inGroup()`, `hasPermission()` and friends from
  `auth.js`. They're for showing and hiding UI. Anyone can bypass them in devtools.
- **Anything you ship is public to staff.** Every signed-in user can download your entire app
  bundle. Never put data, keys, or logic in the bundle that not every signed-in user should see.
- **Vibes storage is not a secrets store.** Don't put credentials or sensitive personal data in
  records or files. Use `owner` or `group:` access for anything that shouldn't be app-wide, and
  assume `shared` collections are readable by any signed-in staff user.
- **An XSS bug in your app is an XSS bug *as* your app** — it inherits your app's identity and can
  reach everything your app can. Escape anything a user typed before putting it in the DOM.

## A minimal working page

See the `index.html` in this template — it loads `/_shared/auth.js`, greets the current user, reads
and writes a record through `/_shared/data.js`, and falls back cleanly when the platform isn't
available (e.g. opening the file locally). The `notes` collection it writes to is declared in the
`vibes.json` beside it. Start from both.

## Deploying

1. Build your app so `index.html` is at the root and only allowed file types remain.
2. Zip it (`index.html` at the top level).
3. On the app's detail page in HAL, use the **Deploy** card to upload the zip. You'll see the deploy
   log, secret-scan results, and — once published — the versions list where you can roll back or
   delete old versions.
