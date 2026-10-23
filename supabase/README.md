# Presentation Studio backend

This directory supplies the Supabase database, private Storage policies, and the `studio-access` Edge Function. It does not contain project credentials or create cloud resources by itself. Use a dedicated Supabase project: the migration intentionally fails if these tables or bucket names already exist rather than replacing unrelated application data.

## Access model

- An authenticated account must have a confirmed email matching `studio_members`. The database reads the current email and confirmation from `auth.users`; user metadata and JWT role claims cannot grant membership.
- `admin` members upload/delete presentations, manage members, and edit. `editor` members can view/present and save changes to every presentation in this Studio. This is one shared client workspace, not a multi-client tenancy boundary.
- No anonymous presentation or file access is granted. Original files and images are in private buckets. Revoking the membership blocks the next database/Storage request even if an Auth session still exists.
- Direct writes to presentations/members are not granted to browser users. Saves go through a revision-checked RPC. Membership changes go through a verified administrator endpoint and a locked, service-only database transaction.
- Original files and replacement images are immutable. Upload with `upsert: false` and a fresh UUID path. Removing a presentation deletes its metadata first, then allows an admin to clean its private objects.

## Deploy and bootstrap

1. Use a dedicated project and apply `migrations/202610230001_presentation_studio.sql`. For the one-time connector bootstrap below, also apply `202610230002_studio_bootstrap.sql`. Each migration is transactional. The global Storage file limit must allow 40 MiB (41,943,040 bytes); individual buckets have tighter limits as listed below.
2. Keep email/password authentication enabled. Disable public signups in Auth settings when available. Uninvited accounts are denied by the allowlist even if public Auth signup remains enabled.
3. Deploy `studio-access` including `handler.mjs` and `_shared/invitations.mjs`. The optional `STUDIO_SITE_URL` overrides the exact default Studio URL in `index.ts`; change that default when reusing this project elsewhere. The deployed Studio origin is allowed automatically. Optional `STUDIO_ALLOWED_ORIGINS` is a comma-separated list of exact development origins; remove development origins before delivery. Never allow `*` or the opaque iframe origin `null`.
4. Supabase supplies `SUPABASE_URL` and server credentials. The function prefers `SUPABASE_SECRET_KEYS.default`, with `SUPABASE_SERVICE_ROLE_KEY` as a compatibility fallback. These credentials stay in the server environment. `verify_jwt = false` is intentional: the function verifies every caller itself using `auth.getUser(jwt)` and then checks server-stored membership.
5. Bootstrap the owner's first membership using either the short-lived connector workflow below or the Dashboard. For the Dashboard route, create the owner account privately, confirm its email, then insert its exact email/ID as the first `admin` membership. Never put a password in source, SQL or chat.
6. Put only the project URL and **publishable** key in `studio/config.json` as `supabaseUrl` and `publishableKey`. The owner can then create client invitations in the Studio. `auth.admin.generateLink` creates manual links without sending email or requiring SMTP.
7. Invitations use the fixed Studio URL plus a fragment: `#welcome=1&token_hash=...&type=invite` (or `magiclink` for an existing account). The Studio captures and immediately removes this fragment before constructing its Auth client, calls `supabase.auth.verifyOtp({ token_hash, type })`, and shows **Set password**. It calls `supabase.auth.updateUser({ password })` in the parent Studio. No Auth session enters the presentation iframe. This direct token verification does not require redirect allowlisting.

The invitation is a one-time bearer credential. Share it privately with the intended recipient. Do not put it in logs, analytics, source files, exported presentations, or a public guide. Fragments keep it out of static-host request logs and referrers. Admin responses use `Cache-Control: no-store`. An admin can generate an expired invitation again; failures after allowlisting explicitly report the partial outcome so the admin can retry.

### One-time connector bootstrap

This workflow is for an empty, dedicated project where the operator cannot configure server secrets through the connector. It does not embed a service key or require the operator to choose the owner's password.

- Generate a random 256-bit capability locally and keep it in a private file outside Git with mode `0600`. Store only its SHA-256 digest, the exact owner email, and a short expiration in the private database bootstrap row and in the deployed `studio-bootstrap/deployment-config.ts` payload. The committed template contains placeholders only.
- Deploy `studio-bootstrap` with its handler, invitation helper and deployment values. POST the capability in `x-studio-setup` from an operator-side client without an Origin header. Do not put the capability in a URL, command argument, or log.
- The service-only claim RPC atomically reserves the empty project. The function creates an invitation without emailing, records the first admin membership, and returns the private owner link. A confirmed owner email is still required before access is granted.
- The function encrypts the successful response with AES-GCM using a key derived from the original capability. A lost HTTP response can be retried with the same capability without minting a second link. The database stores only ciphertext, and concurrent claims cannot both proceed.
- Immediately replace the deployed function with `studio-bootstrap/disabled.ts` after retrieving the link. Keep the private link outside the public repository and let the owner open it and set their password. Do not consume it during automated QA.

A temporary `studio-test-setup` helper can seed an exact SHA-256-matched original and create confirmed synthetic QA accounts. Its capability is also private, short-lived and rejected from browser origins. Deploy its exact generated account IDs after provisioning; cleanup then verifies those IDs, emails and server-set test tags before deleting only those accounts. After QA, clean up the accounts and replace this function with the same unconditional 410 stub. Never leave either setup endpoint active as part of normal operation.

## Database and Storage contract

`presentations` rows contain:

```text
id: UUID
title: 1–160 characters
original_filename: 1–255 characters
slide_count: integer 1–500
format: html | pdf | pptx
original_path: <id>/original.<format>
cover_path: null | <id>/cover.png | <id>/cover.jpeg | <id>/cover.webp
patches: validated map, initially {}
revision: integer, initially 0
created_at, updated_at, created_by, updated_by
```

| Bucket | Upload/read rules | Limits and paths |
|---|---|---|
| `studio-originals` | Admin uploads before metadata creation; all members read existing presentations | 40 MiB; HTML, PDF, PPTX MIME types; `<id>/original.<format>` |
| `studio-covers` | Admin uploads; all members read existing presentations | 2 MiB; PNG/JPEG/WebP; `<id>/cover.<extension>` |
| `studio-images` | Admin/editor upload after presentation creation; all members read existing presentations | 10 MiB; PNG/JPEG/WebP/GIF; `<presentation-id>/<fresh-random-uuid>.<extension>` |

Use MIME `text/html`, `application/pdf`, or `application/vnd.openxmlformats-officedocument.presentationml.presentation` explicitly for originals. PPTX and PDF support here means original-file storage; conversion/rendering fidelity is a frontend concern. Native PowerPoint animations cannot be recovered by changing the Storage format.

Upload an original first, then call `create_presentation`. If creation fails, remove the newly uploaded orphan files with the admin session. Signed URLs are unnecessary for originals: use authenticated `storage.from(bucket).download(path)` and keep the bytes in the parent Studio. An administrator can list/read orphan objects for cleanup; editors cannot read objects whose presentation no longer exists.

### RPCs

```js
await supabase.rpc('studio_identity'); // { email, role } or null

await supabase.rpc('create_presentation', {
  p_id: presentationId,
  p_title: title,
  p_original_filename: file.name,
  p_slide_count: slideCount,
  p_format: 'html', // or pdf / pptx
  p_original_path: `${presentationId}/original.html`,
  p_cover_path: null,
}); // full presentation row

await supabase.rpc('save_presentation', {
  p_id: presentationId,
  p_patches: compactPatches,
  p_expected_revision: loadedRevision,
}); // full row with revision incremented by one

await supabase.rpc('delete_presentation', {
  p_id: presentationId,
  p_expected_revision: loadedRevision,
}); // removed row; admin then removes its Storage objects
```

The RPC errors use `PT400` for invalid data, `PT403` for missing role, `PT404` for a missing presentation/member, and `PT409` for stale revisions or conflicting membership changes. Never retry a stale save using the new revision automatically: keep the local edits and ask the user to reload or reconcile the new version.

The database validates at most 5,000 patch entries and 2 MiB of serialized JSON. Item IDs match `s[0-9]{2,}-e[0-9]{4,}-(t[0-9]+|i|m)`. Patch forms are:

```json
{
  "s01-e0001-t0": { "text": "Plain text, at most 10,000 characters" },
  "s01-e0002-i": { "asset": "PRESENTATION_UUID/IMAGE_UUID.png", "alt": "At most 2,000 characters" },
  "s01-e0003-i": { "alt": "Description-only change" },
  "s01-e0001-m": { "effect": "fade", "duration": 600, "delay": 0 }
}
```

Effects: `original`, `none`, `fade`, `up`, `down`, `left`, `right`, `zoom`, `pop`. Duration: 100–10,000 ms; delay: 0–10,000 ms. An asset path must belong to the same presentation and already exist in `studio-images`. No URLs, data URIs, HTML, or arbitrary style fields are accepted as image or motion properties. Plain text may contain literal markup characters; render it with `textContent`/text nodes.

The parent converts editor data-URI images to private uploads before saving and restores downloaded images to data URIs before sending patches to the iframe. Never send signed Storage URLs or Supabase credentials into presentation source.

### Admin access endpoint

Send the signed-in user's access JWT in `Authorization: Bearer ...` and the public client key in `apikey` when invoking `/functions/v1/studio-access`:

```json
{ "action": "list" }
{ "action": "invite", "email": "client@example.com", "role": "editor" }
{ "action": "update_role", "email": "client@example.com", "role": "admin" }
{ "action": "revoke", "email": "client@example.com" }
```

Responses are `{ members: [...] }`, `{ member, invite_url, link_type }`, or `{ member }`. Roles are only `admin` and `editor`. The handler verifies the token with Auth, checks verified email and server-stored admin membership, rejects self changes, and calls a service-only transaction that checks the actor again. That transaction serializes membership changes, protects the final administrator, and records an audit entry. Reinviting an existing member cannot silently change their role. Invitation URLs always use the server-configured Studio callback; clients cannot choose a redirect.

## HTML isolation requirements

Uploaded HTML is active, untrusted content. The Studio must render it in an iframe with `sandbox="allow-scripts"` and **without** `allow-same-origin`. Keep the auth client/session exclusively in the parent. Use a narrow, versioned message bridge that checks `event.source === iframe.contentWindow`, validates payload shape/size and item IDs, and only applies edits to the currently opened presentation. Do not implement a generic fetch, URL-open, eval, credential, or storage bridge. The opaque iframe origin is `null` and is explicitly rejected by the admin endpoint.

## Verification

```sh
node --test supabase/tests/*.test.mjs
python3 supabase/tests/run_database_tests.py
```

The Node tests execute the actual access and bootstrap handlers with mocked Auth/database clients, including encrypted idempotent bootstrap recovery. The database suite runs the real migration and authorization checks on a disposable PostgreSQL 17 container using small Auth/Storage schema fixtures; no host port is exposed and the container is removed afterward. Tests cover unauthenticated/unverified/nonmember access, role escalation, storage paths, immutable objects, cross-deck image references, invalid edits, stale-write preservation, revocation, admin-only deletion, and audited membership changes.

These checks do not replace a deployed Supabase smoke test. Before client delivery, verify a real manual invite, password creation, sign-in, each supported file upload/download, a save/reload from a second browser, stale-save rejection, and immediate access denial after revocation.

Sources checked against official documentation: [API keys](https://supabase.com/docs/guides/getting-started/api-keys), [database functions](https://supabase.com/docs/guides/database/functions), [RLS](https://supabase.com/docs/guides/database/postgres/row-level-security), [Storage access control](https://supabase.com/docs/guides/storage/security/access-control), [Storage upload limits](https://supabase.com/docs/guides/storage/uploads/file-limits), [generateLink](https://supabase.com/docs/reference/javascript/auth-admin-generatelink), [verifyOtp](https://supabase.com/docs/reference/javascript/auth-verifyotp), and [Edge Function authentication](https://supabase.com/docs/guides/functions/auth).
