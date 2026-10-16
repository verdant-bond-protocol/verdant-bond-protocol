# Sensitive-Content Boundaries (#382)

Untrusted content crosses four boundaries in Verdant Bond Protocol. Each boundary has
tests that feed it hostile input and prove the content cannot execute, escape its
sandbox, leak private fields, or bypass an allow-list.

| Boundary | Enforced by | Tests |
|---|---|---|
| Rendering (markdown, links) | `frontend/src/app/shared/pipes/markdown.pipe.ts`, `safe-url.pipe.ts` | `markdown.pipe.spec.ts`, `safe-url.pipe.spec.ts` |
| Downloads (files published to IPFS) | `api/src/projects/ipfs-upload.policy.ts` | `api/src/test/sensitive-content-boundary.spec.ts` |
| Webhooks (inbound deliveries) | `api/src/webhooks/webhook-verification.service.ts` | same spec |
| Exports (data exports) | `api/src/exports/services/export-stream.pipeline.ts` | same spec |

## Rendering

- DOMPurify keeps a fixed tag and attribute allow-list. The tests show that event handlers,
  `<img>`, `<iframe>`, `style`, and `data:`, `vbscript:`, mixed-case `javascript:` and
  entity-obfuscated `javascript:` links are all removed.
- **Fixed: reverse tabnabbing.** The HTML standard ("get an element's noopener") implies
  `noopener` only for `target="_blank"` when the link has no `rel="opener"`. A named target
  (`target="win"`) or `rel="opener"` is allowed through by the pipe's allow-list, and either
  one hands the opened page a `window.opener` it can use to send this tab to a phishing
  page. The pipe now forces `target="_blank"` and `rel="noopener noreferrer"` on any link
  with a `target`. The hook only writes those constants. It runs on a DOMPurify instance
  private to the pipe (`DOMPurify(window)` creates its own hook map), so other DOMPurify
  users in the app are not affected.
- `SafeUrlPipe` only allows `http:`, `https:` and `ipfs:`. Anything else becomes
  `about:blank`, including relative and protocol-relative URLs, which would otherwise
  resolve against the app's own origin.

## Downloads

Today `IpfsService.uploadFile` does not pin the raw file. It pins a JSON wrapper
(`{ filename, content: <base64>, size, mimetype }`) through Pinata's `pinJSONToIPFS`, so the
gateway serves JSON and the file is not rendered at the gateway URL. The risk sits
downstream: any consumer that decodes `content` and opens it with its stored `mimetype`
(a download endpoint, auditor tooling), or a future switch to raw file pinning. Path-style
gateways (`https://gateway/ipfs/<cid>`) serve every CID from one origin, so such a document
would run with that origin's privileges. The upload policy is the single point every file
passes through, so it now rejects active content at ingest with
`UploadRejectedError('ACTIVE_CONTENT')`:

- **HTML-sniffable bytes** in any non-binary upload. These are the WHATWG MIME Sniffing
  `text/html` signatures (`<!DOCTYPE HTML`, `<HTML`, `<SCRIPT`, `<IFRAME`, `<A`, `<P`, `<!--`,
  …, followed by a space or `>`), checked in the first 1445 bytes (the spec's read
  threshold) after leading whitespace. A browser that sniffs such bytes renders them as HTML
  whatever type was declared.
- **Active SVG or XML.** This applies to anything declared or sniffed as `image/svg+xml`,
  and to anything starting with the WHATWG `text/xml` signature (`<?xml`). Browsers run
  scripts in SVG and XHTML inside XML documents, so this also catches an SVG pushed past the
  sniff window by a long prolog, and XHTML inside a `.txt`. The checks cover `<script>`
  (including namespaced `<svg:script>`), `on*=` handlers, `<foreignObject>`, `<iframe>`,
  `<embed>`, `<object>`, `<!ENTITY` declarations, any `href` that does not start with `#`,
  and animation elements that target `href` (`<set attributeName="href"
  to="javascript:…">`). Links are checked against an allow-list (fragment-only) rather than
  a block-list, which also defeats entity-encoded `javascript:`.

Benign uploads still pass: static SVGs with `xlink:href="#id"`, text that mentions `<b>` or
`<svg onload>` mid-sentence (browsers do not render that as markup), and JSON whose string
values contain markup.

## Webhooks

- **Fixed: replay inside a long window.** Processed event ids used to be forgotten after a
  fixed 10 minutes (twice the 5-minute default window). A delivery configured with a longer
  `replayWindowMs`, for example 1 hour, could be replayed from minute 11 onward. Each id is
  now kept until `event.timestamp + replayWindowMs`, the last moment its timestamp could
  still pass the window check. After that, the timestamp check rejects it on its own.
- The tests show that tampered payloads and signatures made with a different secret are
  rejected.
- An unsigned delivery cannot burn a genuine event id, because ids are recorded only after
  a valid signature.
- A 401 response never echoes the expected signature or the secret.

## Exports

- **Fixed: nested leaks.** Forbidden fields were stripped only at the top level of
  `record.data`, so `{ investor: { ssn } }` leaked. Stripping now recurses through nested
  objects and arrays.
- **Fixed: case variants.** `SSN` or `PrivateKey` slipped past the case-sensitive list.
  Matching is now case-insensitive, using a precomputed lower-cased `Set` per role (O(1)
  per key).
- **Fixed: prototype rewrite.** A `__proto__` key from `JSON.parse` was copied with plain
  assignment, which replaced the exported object's prototype. It is now dropped.
- **Fixed: unowned records.** An investor was given a record with no `ownerUserId`. Those
  records are now refused (fail closed). The worker handler always sets the owner, so
  existing exports are unaffected.

Sanitising a record is O(n) in time and space, where n is the number of nodes in
`record.data`. Chunked streaming is unchanged.

## Compatibility

No public API, DTO or response shape changed. The behaviour that changed:

| Change | Who is affected | Migration |
|---|---|---|
| Active-content uploads now get `ACTIVE_CONTENT` | Clients uploading scripted SVG or HTML disguised as text | Re-export the SVG without scripts or external links (e.g. via an optimiser with scripts disabled), or upload it as PNG/PDF |
| Investor export of unowned records is refused | Custom record sources that omit `ownerUserId` | Set `ownerUserId` on every record |
| Markdown links with `target` open as `_blank` with `noopener noreferrer` | Content relying on a named window or `window.opener` | None. This is the intended protection |

## Failure modes and edge cases

- **False positive on an upload.** A plain-text file that really does start with `<p>` or
  `<a ` is rejected, because a browser would render it as HTML. Indent it or wrap it in a
  code fence, or upload it as PDF.
- **SVG with external fonts or images** is rejected, because any non-fragment `href` is
  refused. Inline or rasterise the asset.
- **Webhook id memory** is now bounded by the configured window, not by a fixed 10 minutes.
  A very long window holds more ids. The existing cleanup at 10,000 entries still evicts
  only ids that are past their window.
- **Multiple API instances.** Replay memory is per process, as before. A replay sent to a
  different instance inside the window is not detected. Use a shared store if you
  scale out.

## Rollback

Each fix is self-contained in one file and can be reverted on its own with
`git revert <commit> -- <file>`. Reverting the upload policy reopens stored-XSS on the
gateway origin. Before reverting it, set `IPFS_SCAN_ENABLED=true` with a scan hook that
rejects active content. No data migration is involved, and nothing written under the new
rules needs to be undone.
