---
name: Grudge asset CDN quirks
description: Serving rules of assets.grudge-studio.com (grudge-assets R2 bucket) that break animation/model fetches
---
- The public worker at assets.grudge-studio.com returns 404 for any R2 key containing spaces (%20 is not matched to the stored key). **Why:** this silently broke the whole Mixamo clip library in Aug 2026 — every champion fell back to procedural animation, which players reported as "character faces 90 degrees off when running". **How to apply:** store new asset keys space-free (underscores); if a remote clip 404s, suspect the key, not the code.
- The worker also 403s non-browser user agents (python urllib) but serves curl and browsers — verify availability with curl.
- R2 admin: CF_WORKER_R2_API token + CF_ACCOUNT_ID work against api.cloudflare.com /r2/buckets/... (list/GET/PUT objects); bucket for public assets is `grudge-assets`.
- A failed clip fetch logs "Mixamo library failed to load; using procedural animation" in the browser console — check that first for any animation-quality complaint.
