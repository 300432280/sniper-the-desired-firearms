# Review Report: bullseyenorth.com

**Profile:** D:\VScode\Projects\firearm-alert\docs\site-audit\bullseyenorth.com-2026-04-27T12-00-00-000Z.json
**Timestamp:** 2026-04-28T08:11:05.362Z
**Overall Verdict:** PASS
**Approved for DB Write:** true

## Stage Results

| Stage | Name | Verdict | Errors |
|-------|------|---------|--------|
| 1 | Spec Compliance | PASS | none |
| 2 | Live Walk Test | PASS | none |
| 3 | Multi-Method Count | PASS | none |
| 4 | Operator Review | PASS | none |
| 5 | Output Review Report | PASS | none |

### Stage 1: Spec Compliance

**Verdict:** PASS

**Details:**
```json
{
  "validatorResult": {
    "valid": true,
    "score": 100,
    "passed": [
      "platform",
      "hasWaf",
      "expectedProductCount",
      "catalogUrls",
      "paginationPattern",
      "perPage",
      "adapterType",
      "crawlers.watermark.method",
      "sortVerification",
      "wafType",
      "wafLastProbedAt",
      "productCountMethod",
      "lastVerified",
      "profileVersion",
      "sortParam",
      "extractionTested"
    ],
    "requiredFailures": [],
    "warnings": []
  }
}
```

### Stage 2: Live Walk Test

**Verdict:** PASS

**Details:**
```json
{
  "perUrl": [
    {
      "url": "https://bullseyenorth.com/all-products/browse/orderby/new-arrivals/perpage/36",
      "page1Products": 36,
      "page1Slugs": [
        "promag-sks-polymer-drum-magazine-black-762x39mm-5-50-rounds-drma48-37235",
        "canuck-enforcer-shotgun-distressed-od-green-12-gauge-3-chamber-17-barrel-cenfdod1217-37363",
        "canuck-enforcer-shotgun-distressed-bronze-12-gauge-3-chamber-17-barrel-cenfdbz1217-37361"
      ],
      "page2Products": 3,
      "page2Slugs": [
        "derya-tm22-cadet-semiauto-rifle-22lr-18-barrel-od-green-tm22cad18odg-37341",
        "walkers-restrictor-rechargeable-earbuds-bluetooth-black-gwprstrbt-35766",
        "walkers-recon-hybrid-communicator-bluetooth-walkie-talkie-gwprecmbtwt-36321"
      ],
      "page3Products": 36,
      "paginationVerdict": "PASS"
    }
  ]
}
```

### Stage 3: Multi-Method Count

**Verdict:** PASS

**Details:**
```json
{
  "counts": {
    "walk": 3270
  },
  "driftPairs": {
    "walk-expected": 0
  },
  "availableMethods": 1
}
```

### Stage 4: Operator Review

**Verdict:** PASS

**Details:**
```json
{
  "mode": "approve",
  "stagesPass": true,
  "approved": true
}
```

### Stage 5: Output Review Report

**Verdict:** PASS

**Details:**
```json
{}
```

## Next Steps

Profile approved for DB write. Run:
```
npx tsx backend/scripts/enable-new-site.ts D:\VScode\Projects\firearm-alert\docs\site-audit\bullseyenorth.com-2026-04-27T12-00-00-000Z.json
```
