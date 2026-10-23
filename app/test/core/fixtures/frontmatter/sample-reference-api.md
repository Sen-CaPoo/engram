---
name: sample-reference-api
description: Sample API v2 renamed item fields to entry fields in 2026; verified live 2026-10-09; pay-per-use billing per returned resource
metadata:
  node_type: memory
  type: reference
  originSessionId: 6f2cd7d4-6150-43e6-8e7a-14dbc68a8c88
  modified: 2026-10-09T15:03:58.003Z
---

Sample API v2 (spec at https://api.example.test/2/openapi.json) on GET /2/users/:id/items:
- query: `entry.fields` (not item.fields), expansion `referenced_entries`
- response: `data[].referenced_entries`, `includes.entries`

Billing is per returned resource, so keep `max_results` small during tests.
