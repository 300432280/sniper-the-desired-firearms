# Review Report: bullseyenorth.com

**Profile:** D:\Projects\FIREARM-ALERT\docs\site-audit\bullseyenorth.com-2026-05-04T03-31-22-137Z.json
**Timestamp:** 2026-05-04T03:39:39.500Z
**Overall Verdict:** PASS
**Approved for DB Write:** false

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
        "henry-homesteader-h027-magazine-well-adaptor-smith-wesson-mp-and-sig-sauer-p320-magazines-37065",
        "beretta-full-mesh-ebony-ice-grey-shooting-vest-xxl-37416",
        "beretta-full-mesh-ebony-ice-grey-shooting-vest-large-37413"
      ],
      "page2Products": 3,
      "page2Slugs": [
        "charles-daly-101-single-barrel-shotgun-20-gauge-3-chamber-26-barrel-walnut-930235-36994",
        "hera-cqr-close-quarters-rifle-ar15-buttstock-od-green-1214-37221",
        "federation-firearms-sa2-semiauto-shotgun-20-gauge-3-chamber-26-barrelgrey-w-mossy-oak-camo-ffsa220gre26-37389"
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
    "walk": 3263
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
  "mode": "default",
  "stagesPass": true,
  "approved": false
}
```

### Stage 5: Output Review Report

**Verdict:** PASS

**Details:**
```json
{
  "jsonPath": "D:\\Projects\\FIREARM-ALERT\\docs\\site-audit\\bullseyenorth.com-2026-05-04T03-39-39-500Z-review.json",
  "mdPath": "D:\\Projects\\FIREARM-ALERT\\docs\\site-audit\\bullseyenorth.com-2026-05-04T03-39-39-500Z-review.md"
}
```

## Next Steps

Profile NOT approved for DB write. Review the blocking errors above.
Re-run with `--approve` after fixing issues, or use `--prompt` for interactive approval.
