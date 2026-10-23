---
# 舊格式：頂層 engram 區塊與行內陣列
name: 'sample-legacy-engram'
description: 'It''s a legacy file with a single-quoted description: colons and #hash inside quotes'
engram:
  pinned: false
  tags: [alpha, "beta gamma", 'delta']
  note: plain value # trailing comment
metadata:
  type: project
  count: 42
  ratio: 0.5
  enabled: yes
  empty:
  nothing: ~
  flow: {}
---
Body starts right after the closing line without a blank line.
