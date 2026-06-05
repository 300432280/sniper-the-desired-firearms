// backend/src/services/__test__/product-classifier-out-of-scope-2026-06-05.test.ts
//
// out_of_scope productType: apparel + lifestyle goods must classify as
// out_of_scope (so the search/alert path can hide them), while genuine
// firearm-adjacent kit (body armor, ballistic eyewear, range bags,
// weaponlights, etc.) must NEVER be flagged out_of_scope.
//
// Enforces the user's hard rule "non-firearm products shall not appear in the
// app" without hiding any shooting/hunting-functional product.
import { describe, it, expect } from 'vitest';
import { classifyProduct } from '../product-classifier';

const c = (title: string, url = 'https://example.com/product/' + encodeURIComponent(title)) =>
  classifyProduct({ title, url });

// tags/url-aware helper for the structural-signal tests.
const cx = (title: string, url: string, tags?: string) =>
  classifyProduct({ title, url, tags: tags ?? null });

describe('out_of_scope — apparel is hidden', () => {
  const apparel = [
    'The Shooting Centre Logo T-Shirt',
    'Range Day Hoodie - Black',
    'Pro Staff Hoody',
    'Embroidered Crewneck Sweatshirt',
    'Trucker Hat - Mesh Back',
    'Snapback Cap - Olive',
    'Winter Beanie Toque',
    'Flexfit Fitted Cap',
    'Cotton Polo Shirt',
    'Long Sleeve Shirt - Grey',
    'Logo Patch Hat',
    'Merino Wool Socks',
    'Brand Pullover',
    'Tactical Tee Shirt',
  ];
  for (const t of apparel) {
    it(`apparel -> out_of_scope: ${t}`, () => {
      expect(c(t)).toBe('out_of_scope');
    });
  }
});

describe('out_of_scope — lifestyle is hidden', () => {
  const lifestyle = [
    'YETI Rambler 20oz Tumbler',
    'YETI Tundra 45 Cooler',
    'Zippo Windproof Lighter',
    'HeatBank Rechargeable Hand Warmer',
    'Groove Wallet - Carbon',
    'Groove Belt',
    'Peak Refuel Beef Stroganoff',
    'ReadyWise Emergency Food Bucket',
    'Mountain House Chili Mac',
    'Sawyer Water Filter',
    'Katadyn Microfilter',
  ];
  for (const t of lifestyle) {
    it(`lifestyle -> out_of_scope: ${t}`, () => {
      expect(c(t)).toBe('out_of_scope');
    });
  }
});

describe('KEEP — firearm-adjacent kit is NEVER out_of_scope', () => {
  // These titles brush an apparel/lifestyle word but are genuine shooting kit.
  const keep = [
    'Level IV Body Armor Plate',
    'Plate Carrier Vest - Multicam',
    'Ballistic Armour Panel',
    'Gatorz Magnum Ballistic Eyewear',
    'Wiley X Ballistic Safety Glasses',
    'Range Bag - Tactical Carry',
    'Hard Gun Case - 42 inch',
    'Soft Rifle Case - Padded',
    'Pistol Case - Lockable',
    'Streamlight TLR-1 Weapon Light',
    'SureFire Weaponlight',
    'CAT Tourniquet - Combat Application',
  ];
  for (const t of keep) {
    it(`keep (not out_of_scope): ${t}`, () => {
      expect(c(t)).not.toBe('out_of_scope');
    });
  }
});

describe('KEEP — functional caps + socks are NEVER out_of_scope (BLOCKER 1)', () => {
  // Optics/parts "caps" and cleaning/storage "socks" that were wrongly hidden by
  // the bare apparel " cap"/"socks" token. The part-noun need not be adjacent to
  // "cap" (e.g. "Cap adjustment screw", "Firing Pin Cap Retainer").
  const keepParts = [
    'Primary Arms AutoLive Battery Cap',
    'Aimpoint Battery Cap',
    'EOTech Battery Cap',
    'Aimpoint Cap adjustment screw',
    'NOBLEX Eyepiece Cap',
    'Swarovski Push-on Eyepiece Cap',
    'S&B Elevation Cap',
    'Firing Pin Cap Retainer',
    'Main Spring Cap',
    'Gas Regulator Cap',
    'Mag Tube Cap',
    'Steyr Bolt Cap',
    'Snow Cap Tension Spring',
    'Boresnake Sock',
    'Recoil Pad Sock',
    'Allen Handgun Sock 14"',
    // R1's 10 surviving functional parts (2026-06-05) — the inverted KEEP-by-
    // default cap/hat branch must never hide these.
    'Midwest Marlin M-Lok Handguard w/ handguard cap',
    'Upper Handguard Cap',
    'MEC-GAR 1911 .45 8rd 8 High Cap',
    'Hogue GRIPS S&W K&L FRAME STRIPE CAP CHECKERED ROSEWOOD',
    'Wheeler NIEDNER-STYLE BUTTPLATE & CAP 9MM',
    'North 49 Barrel Cooler',
    'Mag. Release Cap',
  ];
  for (const t of keepParts) {
    it(`keep functional part (not out_of_scope): ${t}`, () => {
      expect(c(t)).not.toBe('out_of_scope');
    });
  }
});

describe('INVERTED cap/hat branch: bare brand cap with NO apparel signal is KEPT', () => {
  // FIX 1 (2026-06-05): the cap/hat branch is KEEP-by-default. A bare branded
  // "Brand Cap"/"Brand Hat" with no positive apparel signal must NOT be hidden —
  // accepting that a pure apparel cap may leak into search is the lesser error vs
  // hiding a firearm part.
  const keptBareCaps = ['Browning Telford Cap', 'CZ Sports Cap Black', 'Tilley T5 Hat'];
  for (const t of keptBareCaps) {
    it(`bare brand cap/hat (no apparel signal) -> KEEP: ${t}`, () => {
      expect(c(t)).not.toBe('out_of_scope');
    });
  }
});

describe('cap/hat WITH a positive apparel signal is still hidden', () => {
  // The inverted branch still hides a bare cap/hat when an explicit headwear/merch
  // signal is present (trucker, snapback, flexfit, fitted, mesh-back, baseball cap,
  // visor, knit, wool, embroidered logo, camo cap, …).
  const hidden = [
    'Trucker Hat - Mesh Back',
    'Snapback Cap - Olive',
    'Flexfit Fitted Cap',
    'Baseball Cap - Navy',
    'Browning Embroidered Logo Cap',
    'Camo Cap - Realtree',
    'Knit Beanie Toque',
  ];
  for (const t of hidden) {
    it(`apparel-signalled cap/hat -> out_of_scope: ${t}`, () => {
      expect(c(t)).toBe('out_of_scope');
    });
  }
});

describe('INVERTED sock branch: functional/bundled "sock" titles are KEPT (FIX 3)', () => {
  // R1's 3 survivors: bare "socks?" used to fire unconditionally in the STRONG
  // branch, hiding a real scope, a shotgun case, and a gun-storage sock. The
  // inverted sock branch is KEEP-by-default; these (and proactive bundled-token
  // cases) must NOT be hidden. Tests now carry the real bundled-token titles that
  // let parts leak past the green suite four times.
  const keepSocks = [
    'Leupold VX-3 2.5-8x36 Riflescope WITH LEUPOLD SOCK',
    'Beretta/Negrini Covey Takedown 1 Shotgun Case, Castellani Cover, Beretta Socks, New',
    'Vci Gun Protection Sock 2 Pcs',
    'Vortex Viper PST 5-25x50 FFP Scope with sock',
    'Tikka T3X Rifle with cleaning socks bundle',
    'Boresnake Sock',
    'Recoil Pad Sock',
    'Allen Scoped Rifle Sock 52"',
  ];
  for (const t of keepSocks) {
    it(`functional/bundled sock -> KEEP: ${t}`, () => {
      expect(c(t)).not.toBe('out_of_scope');
    });
  }
});

describe('sock WITH a positive apparel-sock signal is still hidden', () => {
  // Genuine clothing socks still hide via the apparel-sock signal (material/style/
  // pack words), with no firearm/optics/case context present.
  const hiddenSocks = [
    'Merino Wool Crew Socks',
    'Vortex Hunt Sock',
    'Compression Socks',
    'Darn Tough Boot Sock, Large',
    'Athletic Ankle Socks 3-Pack',
  ];
  for (const t of hiddenSocks) {
    it(`apparel sock -> out_of_scope: ${t}`, () => {
      expect(c(t)).toBe('out_of_scope');
    });
  }
});

describe('STRUCTURAL firearm-scope signal beats ALL out_of_scope branches (FIX 4)', () => {
  // A lifestyle-brand-edition firearm/optic (YETI/Zippo/Rambler colorway in the
  // TITLE) must NOT be hidden when the platform taxonomy (url path / tags /
  // sourceCategory) says firearm-scope. Token enumeration of brand colorways
  // can't fix this class; the structural veto does, generically. R1's note: the
  // suite passed green 5x because no test had a firearm-with-lifestyle-brand
  // title — this block fixes that.
  it('R1 survivor: Mossberg Patriot YETI rifle (firearm url + FIREARMS tag) -> firearm', () => {
    expect(cx(
      'USED MOSSBERG PATRIOT YETI 6.5 CREED',
      'https://shooterschoice.com/4022-firearms/used-rifles/used-centerfire-bolt-rifle/mossberg-patriot-yeti',
      'FIREARMS,MOSSBERG,USED CENTERFIRE BOLT RIFLE',
    )).toBe('firearm');
  });
  it('Zippo-edition rifle with /firearms/rifles/ url + RIFLE tag -> not out_of_scope', () => {
    expect(cx('Zippo Edition Henry Golden Boy .22LR', 'https://x.com/firearms/rifles/henry-zippo', 'FIREARMS,RIFLE'))
      .not.toBe('out_of_scope');
  });
  it('Rambler-edition riflescope with /optics/scopes/ url + OPTICS tag -> not out_of_scope', () => {
    expect(cx('Vortex Razor Rambler Edition Riflescope', 'https://x.com/optics/scopes/vortex-razor', 'OPTICS,SCOPE'))
      .not.toBe('out_of_scope');
  });
  it('YETI-colorway Glock with /handguns/ url + PISTOL tag -> not out_of_scope', () => {
    expect(cx('YETI Colorway Glock 19 Gen5', 'https://x.com/handguns/glock-19', 'FIREARMS,PISTOL'))
      .not.toBe('out_of_scope');
  });
});

describe('CONTROLS: apparel/drinkware/lifestyle still hide (no firearm structural signal)', () => {
  // The structural veto must NOT leak apparel: a /gear/apparel path or DRINKWARE
  // tag is NOT a firearm signal, so these still hide.
  it('Browning Camp T-Shirt under /gear/apparel (APPAREL tag) -> out_of_scope', () => {
    expect(cx('Browning Camp T-Shirt, Whitetail Black', 'https://x.com/gear/apparel/browning-camp-tshirt', 'APPAREL,CLOTHING'))
      .toBe('out_of_scope');
  });
  it('YETI Rambler 30oz under /gear/drinkware (DRINKWARE tag) -> out_of_scope', () => {
    expect(cx('YETI Rambler 30oz Tumbler', 'https://x.com/gear/drinkware/yeti-rambler', 'DRINKWARE'))
      .toBe('out_of_scope');
  });
  it('Vortex Hunt Sock under /apparel/socks (APPAREL tag) -> out_of_scope', () => {
    expect(cx('Vortex Hunt Sock', 'https://x.com/apparel/socks/vortex-hunt', 'APPAREL')).toBe('out_of_scope');
  });
});

describe('KEEP — core firearm/ammo/optics/parts unaffected', () => {
  it('rifle stays firearm', () => {
    expect(c('Ruger 10/22 Carbine .22 LR Rifle')).toBe('firearm');
  });
  it('ammo stays ammunition', () => {
    expect(c('Federal 9mm 115gr FMJ - 50 Rounds')).toBe('ammunition');
  });
  it('scope stays optics', () => {
    expect(c('Vortex Viper PST 3-9x40 Riflescope')).toBe('optics');
  });
  it('magazine stays parts', () => {
    expect(c('Magpul PMAG 30 Round Magazine')).toBe('parts');
  });
});
