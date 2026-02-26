/**
 * Seed common firearm keyword groups and aliases.
 *
 * Usage: npx ts-node src/scripts/seed-keywords.ts
 *
 * Each group has a canonical name and a list of aliases that should
 * all match the same products. Users searching for any alias will
 * get results matching all variations.
 */

import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

interface KeywordGroupSeed {
  canonical: string;
  aliases: string[];
}

const KEYWORD_GROUPS: KeywordGroupSeed[] = [
  // ── Ruger ──────────────────────────────────────────────────────────────
  { canonical: 'Ruger 10/22', aliases: ['ruger 10/22', 'ruger 1022', 'ruger 10 22', '10/22', '1022'] },
  { canonical: 'Ruger Mini-14', aliases: ['ruger mini-14', 'ruger mini 14', 'ruger mini14', 'mini-14', 'mini 14'] },
  { canonical: 'Ruger PC Carbine', aliases: ['ruger pc carbine', 'ruger pcc', 'pc carbine', 'pc9'] },
  { canonical: 'Ruger American', aliases: ['ruger american', 'ruger american rifle'] },
  { canonical: 'Ruger Precision', aliases: ['ruger precision', 'ruger precision rifle', 'rpr'] },
  { canonical: 'Ruger Mark IV', aliases: ['ruger mark iv', 'ruger mark 4', 'ruger mkiv', 'ruger mk4', 'mark iv'] },
  { canonical: 'Ruger Wrangler', aliases: ['ruger wrangler', 'wrangler'] },

  // ── SKS ────────────────────────────────────────────────────────────────
  { canonical: 'SKS', aliases: ['sks', 'sks-45', 'sks 45', 'type 56', 'norinco sks', 'russian sks', 'chinese sks'] },

  // ── CZ ─────────────────────────────────────────────────────────────────
  { canonical: 'CZ 75', aliases: ['cz 75', 'cz75', 'cz-75', 'ceska zbrojovka 75'] },
  { canonical: 'CZ 457', aliases: ['cz 457', 'cz457', 'cz-457'] },
  { canonical: 'CZ 600', aliases: ['cz 600', 'cz600', 'cz-600'] },
  { canonical: 'CZ Shadow 2', aliases: ['cz shadow 2', 'shadow 2', 'cz shadow2'] },
  { canonical: 'CZ Bren 2', aliases: ['cz bren 2', 'bren 2', 'cz bren2', 'bren2'] },

  // ── Remington ──────────────────────────────────────────────────────────
  { canonical: 'Remington 870', aliases: ['remington 870', 'rem 870', 'remington870', 'rem870', 'r870'] },
  { canonical: 'Remington 700', aliases: ['remington 700', 'rem 700', 'remington700', 'rem700', 'r700'] },

  // ── Glock ──────────────────────────────────────────────────────────────
  { canonical: 'Glock 17', aliases: ['glock 17', 'glock17', 'g17'] },
  { canonical: 'Glock 19', aliases: ['glock 19', 'glock19', 'g19'] },
  { canonical: 'Glock 34', aliases: ['glock 34', 'glock34', 'g34'] },
  { canonical: 'Glock 48', aliases: ['glock 48', 'glock48', 'g48'] },

  // ── Smith & Wesson ─────────────────────────────────────────────────────
  { canonical: 'Smith & Wesson M&P', aliases: ['smith wesson m&p', 's&w m&p', 'sw m&p', 'm&p', 'mp shield'] },
  { canonical: 'Smith & Wesson 686', aliases: ['s&w 686', 'sw 686', 'smith wesson 686', '686'] },

  // ── Browning ───────────────────────────────────────────────────────────
  { canonical: 'Browning BAR', aliases: ['browning bar', 'bar mk3', 'bar mk 3'] },
  { canonical: 'Browning BPS', aliases: ['browning bps', 'bps'] },
  { canonical: 'Browning Citori', aliases: ['browning citori', 'citori'] },
  { canonical: 'Browning X-Bolt', aliases: ['browning x-bolt', 'browning xbolt', 'x-bolt', 'xbolt'] },

  // ── Winchester ─────────────────────────────────────────────────────────
  { canonical: 'Winchester SXP', aliases: ['winchester sxp', 'sxp'] },
  { canonical: 'Winchester Model 70', aliases: ['winchester model 70', 'winchester 70', 'model 70'] },

  // ── Benelli ────────────────────────────────────────────────────────────
  { canonical: 'Benelli Super Black Eagle', aliases: ['benelli sbe', 'super black eagle', 'benelli super black eagle', 'sbe3', 'sbe 3'] },
  { canonical: 'Benelli M4', aliases: ['benelli m4', 'benelli m 4'] },
  { canonical: 'Benelli M2', aliases: ['benelli m2', 'benelli m 2'] },

  // ── Beretta ────────────────────────────────────────────────────────────
  { canonical: 'Beretta 1301', aliases: ['beretta 1301', '1301 tactical', '1301 comp'] },
  { canonical: 'Beretta A400', aliases: ['beretta a400', 'a400 xtreme', 'a400'] },
  { canonical: 'Beretta 92', aliases: ['beretta 92', 'beretta 92fs', 'beretta 92x', '92fs', '92x'] },

  // ── Mossberg ───────────────────────────────────────────────────────────
  { canonical: 'Mossberg 500', aliases: ['mossberg 500', 'moss 500'] },
  { canonical: 'Mossberg 590', aliases: ['mossberg 590', 'mossberg 590a1', 'moss 590', '590a1'] },
  { canonical: 'Mossberg 940', aliases: ['mossberg 940', 'mossberg 940 jm', '940 jm pro'] },

  // ── Savage ─────────────────────────────────────────────────────────────
  { canonical: 'Savage 110', aliases: ['savage 110', 'savage 110 tactical', 'savage110'] },
  { canonical: 'Savage Mark II', aliases: ['savage mark ii', 'savage mark 2', 'savage mkii', 'savage mk2'] },
  { canonical: 'Savage A22', aliases: ['savage a22', 'a22'] },
  { canonical: 'Savage 64', aliases: ['savage 64', 'savage model 64', 'savage 64f'] },

  // ── Tikka ──────────────────────────────────────────────────────────────
  { canonical: 'Tikka T3x', aliases: ['tikka t3x', 'tikka t3', 't3x', 't3x lite'] },
  { canonical: 'Tikka T1x', aliases: ['tikka t1x', 't1x'] },

  // ── Sig Sauer ──────────────────────────────────────────────────────────
  { canonical: 'Sig Sauer P320', aliases: ['sig p320', 'sig sauer p320', 'p320'] },
  { canonical: 'Sig Sauer P226', aliases: ['sig p226', 'sig sauer p226', 'p226'] },
  { canonical: 'Sig Sauer P365', aliases: ['sig p365', 'sig sauer p365', 'p365'] },
  { canonical: 'Sig Sauer Cross', aliases: ['sig cross', 'sig sauer cross'] },

  // ── Henry ──────────────────────────────────────────────────────────────
  { canonical: 'Henry Lever Action', aliases: ['henry lever', 'henry lever action', 'henry 22', 'henry golden boy'] },
  { canonical: 'Henry Big Boy', aliases: ['henry big boy', 'henry bigboy', 'big boy'] },

  // ── Marlin ─────────────────────────────────────────────────────────────
  { canonical: 'Marlin 336', aliases: ['marlin 336', 'marlin 336c', 'marlin 336 dark'] },
  { canonical: 'Marlin 1895', aliases: ['marlin 1895', 'marlin 1895 sbl', '1895 sbl'] },
  { canonical: 'Marlin Model 60', aliases: ['marlin 60', 'marlin model 60'] },

  // ── Stag / WK180 / Canadian rifles ────────────────────────────────────
  { canonical: 'WK180-C', aliases: ['wk180-c', 'wk180c', 'wk 180c', 'wk180', 'kodiak wk180'] },
  { canonical: 'WS-MCR', aliases: ['ws-mcr', 'ws mcr', 'wsmcr', 'wolverine ws-mcr'] },
  { canonical: 'Type 81', aliases: ['type 81', 'type81', 'norinco type 81'] },

  // ── Caliber searches ──────────────────────────────────────────────────
  { canonical: '.22 LR', aliases: ['22lr', '22 lr', '.22 lr', '.22lr', '22 long rifle'] },
  { canonical: '.223 Remington', aliases: ['223 rem', '.223 rem', '223 remington', '.223', '5.56', '5.56x45', '5.56 nato'] },
  { canonical: '.308 Winchester', aliases: ['308 win', '.308 win', '308 winchester', '.308', '7.62x51', '7.62 nato'] },
  { canonical: '9mm', aliases: ['9mm', '9x19', '9mm luger', '9mm parabellum'] },
  { canonical: '.45 ACP', aliases: ['45 acp', '.45 acp', '45acp', '.45'] },
  { canonical: '12 Gauge', aliases: ['12 gauge', '12ga', '12 ga', '12gauge'] },
  { canonical: '6.5 Creedmoor', aliases: ['6.5 creedmoor', '6.5 cm', '6.5cm', '6.5 creed'] },
  { canonical: '.300 Win Mag', aliases: ['300 win mag', '.300 win mag', '300 wm', '.300wm', '300 winchester magnum'] },

  // ── Optics ─────────────────────────────────────────────────────────────
  { canonical: 'Vortex Viper', aliases: ['vortex viper', 'viper pst', 'viper hst'] },
  { canonical: 'Vortex Crossfire', aliases: ['vortex crossfire', 'crossfire ii', 'crossfire 2'] },
  { canonical: 'Vortex Strike Eagle', aliases: ['vortex strike eagle', 'strike eagle'] },
  { canonical: 'Holosun 510C', aliases: ['holosun 510c', 'hs510c', '510c'] },
  { canonical: 'Holosun 507C', aliases: ['holosun 507c', 'hs507c', '507c'] },
  { canonical: 'Aimpoint T2', aliases: ['aimpoint t2', 'aimpoint micro t-2', 'micro t2'] },
];

async function main() {
  console.log(`Seeding ${KEYWORD_GROUPS.length} keyword groups...`);

  let created = 0;
  let updated = 0;

  for (const group of KEYWORD_GROUPS) {
    // Upsert group
    const existing = await prisma.keywordGroup.findUnique({
      where: { canonicalName: group.canonical },
      include: { aliases: true },
    });

    if (existing) {
      // Add any new aliases
      const existingAliases = new Set(existing.aliases.map(a => a.alias));
      const newAliases = group.aliases.filter(a => !existingAliases.has(a));

      if (newAliases.length > 0) {
        for (const alias of newAliases) {
          try {
            await prisma.keywordAlias.create({
              data: { groupId: existing.id, alias },
            });
          } catch {
            // Skip duplicate aliases across groups
          }
        }
        updated++;
      }
    } else {
      try {
        await prisma.keywordGroup.create({
          data: {
            canonicalName: group.canonical,
            aliases: {
              create: group.aliases.map(alias => ({ alias })),
            },
          },
        });
        created++;
      } catch (err) {
        console.warn(`Failed to create group "${group.canonical}":`, err instanceof Error ? err.message : err);
      }
    }
  }

  const totalAliases = KEYWORD_GROUPS.reduce((sum, g) => sum + g.aliases.length, 0);
  console.log(`Done! Created: ${created}, Updated: ${updated}, Total groups: ${KEYWORD_GROUPS.length}, Total aliases: ${totalAliases}`);
}

main()
  .catch(console.error)
  .finally(() => prisma.$disconnect());
