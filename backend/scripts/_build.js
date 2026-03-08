var fs = require("fs");
var SQ = String.fromCharCode(39);
var BS = String.fromCharCode(92);
var DS = String.fromCharCode(36);
var NL = String.fromCharCode(10);
var o = "";
function L(s) { o += s + NL; }
function q(s) { return SQ + s + SQ; }

L("/**");
L(" * diagnose-extractions.js");
L(" * Diagnostic: DB crawl events + live extraction tests");
L(" */");
L("");
L("const { prisma } = require(" + q("../dist/lib/prisma") + ");");
L("const axios = require(" + q("axios") + ");");
L("const cheerio = require(" + q("cheerio") + ");");
L("");
L("const UA = " + q("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36") + ";");
L("");
L("const DOMAINS = [");
L("  " + q("lockharttactical.com") + ",");
L("  " + q("canadasgunstore.ca") + ",");
L("  " + q("canadiangunnutz.com") + ",");
L("  " + q("doctordeals.ca") + ",");
L("  " + q("g4cgunstore.com") + ",");
L("  " + q("sail.ca") + ",");
L("  " + q("precisionoptics.net") + ",");
L("];");
