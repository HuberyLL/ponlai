/*!
 * Portions adapted from tidewater by Daniel Greenheck (https://github.com/dgreenheck/tidewater), src/world/fish/FishSpecies.js.
 * SPDX-FileCopyrightText: Copyright (c) 2026 DRG Software Solutions LLC
 * SPDX-License-Identifier: MIT
 */

import type { Anatomy } from './FishGeometry.ts';
import type { FishSkin } from './SwimmerMaterial.ts';

// The bodies and skins of the sea's creatures.
//
// The bodies and skins of the sea's creatures: real species of a warm-temperate rocky coast that a
// warm current reaches (as the Kuroshio reaches southern Japan, Jeju and north-eastern Taiwan), the
// sea the island's floor already is (mineral sand, eelgrass meadows, boulders; a shelf to some 6 m,
// the open sea deeper). Docs: docs/design/life-and-islanders.md, The sea.
//
// The anatomy tables are in the fish's frame (FishGeometry.ts: the total length 1), their profiles
// from tidewater's FishSpecies (4811ba4) where it has the family (the mullet, a jack, a clupeid's
// slender silverside), the rest drawn from the species' published proportions. The colours are
// sRGB, from photographs of the living animal in the water (counter-shaded: a dark back, a pale
// belly), the silver a fish's guanine layer: a metal-like specular share of its flank.

// ------------------------------------------------------------------ the far-eastern sardine

/** Sardinops melanostictus: a slender clupeid, one dorsal fin mid-back, a forked tail; a row of
 * dark spots along each flank (its name's "black spots"). */
export const SARDINE: Anatomy = {
	body: 0.82, sec: 2.1,
	top: [ [ 0, 0.003 ], [ 0.03, 0.017 ], [ 0.1, 0.038 ], [ 0.25, 0.062 ], [ 0.45, 0.07 ], [ 0.65, 0.057 ], [ 0.85, 0.034 ], [ 1, 0.025 ] ],
	bot: [ [ 0, 0.003 ], [ 0.03, 0.016 ], [ 0.1, 0.036 ], [ 0.25, 0.062 ], [ 0.45, 0.07 ], [ 0.65, 0.053 ], [ 0.85, 0.03 ], [ 1, 0.023 ] ],
	wid: [ [ 0, 0.003 ], [ 0.05, 0.016 ], [ 0.2, 0.031 ], [ 0.4, 0.034 ], [ 0.7, 0.024 ], [ 1, 0.012 ] ],
	dorsal: [ { from: 0.42, to: 0.55, rays: 9, h: [ [ 0, 0.05 ], [ 1, 0.02 ] ], rake: [ 0.5, 0.85 ], notch: 0.015 } ],
	anal: [ { from: 0.74, to: 0.86, rays: 9, h: [ [ 0, 0.025 ], [ 1, 0.015 ] ], rake: [ 0.6, 0.9 ], notch: 0.015 } ],
	pectoral: { u: 0.2, y: - 0.03, rays: 6, lead: 1.0, last: 0.4, len: 0.1, tail: 0.6, dihedral: - 0.15 },
	pelvic: { u: 0.5, y: - 0.06, rays: 4, lead: 0.9, last: 0.4, len: 0.05, tail: 0.6, dihedral: - 0.1 },
	caudal: { len: 0.18, span: 0.11, fork: 0.35, lower: 1, rays: 13 },
};
export const SARDINE_SKIN: FishSkin = {
	back: 0x2c4a5e, flank: 0xb9c6cc, belly: 0xeef0ee, fin: 0x8a979c, finEdge: 0x56646c, iris: 0xd8d8c0,
	silver: 0.95, rough: 0.24,
	eye: { u: 0.075, y: 0.012, r: 0.03 },
	pattern: { kind: 'spotRow', color: 0x1d2a33, h: 0.12, count: 11 },
};

// ------------------------------------------------------------------ the flathead grey mullet

/** Mugil cephalus: a robust, round-backed fish, two dorsal fins far apart, the head broad and
 * flat, dark stripes along the scale rows of its flank (tidewater's mullet). */
export const MULLET: Anatomy = {
	body: 0.82, sec: 2.15,
	top: [ [ 0, 0.008 ], [ 0.03, 0.03 ], [ 0.08, 0.055 ], [ 0.16, 0.08 ], [ 0.28, 0.1 ], [ 0.42, 0.107 ], [ 0.56, 0.1 ], [ 0.7, 0.082 ], [ 0.84, 0.058 ], [ 1, 0.044 ] ],
	bot: [ [ 0, 0.008 ], [ 0.03, 0.028 ], [ 0.08, 0.05 ], [ 0.16, 0.072 ], [ 0.28, 0.088 ], [ 0.42, 0.093 ], [ 0.56, 0.086 ], [ 0.7, 0.07 ], [ 0.84, 0.05 ], [ 1, 0.04 ] ],
	wid: [ [ 0, 0.008 ], [ 0.04, 0.036 ], [ 0.12, 0.06 ], [ 0.25, 0.072 ], [ 0.42, 0.072 ], [ 0.6, 0.06 ], [ 0.8, 0.04 ], [ 1, 0.024 ] ],
	dorsal: [
		{ from: 0.44, to: 0.52, rays: 4, h: [ [ 0, 0.06 ], [ 1, 0.035 ] ], rake: [ 0.35, 0.6 ], notch: 0.125 },
		{ from: 0.66, to: 0.74, rays: 7, h: [ [ 0, 0.06 ], [ 1, 0.025 ] ], rake: [ 0.55, 0.9 ], notch: 0.015 },
	],
	anal: [ { from: 0.62, to: 0.72, rays: 8, h: [ [ 0, 0.055 ], [ 1, 0.025 ] ], rake: [ 0.55, 0.9 ], notch: 0.015 } ],
	pectoral: { u: 0.27, y: 0.03, rays: 7, lead: 1.0, last: 0.35, len: 0.13, tail: 0.6, dihedral: 0.1 },
	pelvic: { u: 0.4, y: - 0.08, rays: 4, lead: 0.9, last: 0.4, len: 0.08, tail: 0.6, dihedral: - 0.1 },
	caudal: { len: 0.18, span: 0.13, fork: 0.6, lower: 1, rays: 15 },
};
export const MULLET_SKIN: FishSkin = {
	back: 0x5b6a63, flank: 0xb4bcbe, belly: 0xe6eaea, fin: 0x848c8c, finEdge: 0x5c6464, iris: 0xc8b890,
	silver: 0.6, rough: 0.33,
	eye: { u: 0.075, y: 0.03, r: 0.022 },
	pattern: { kind: 'stripes', color: 0x4e5753, count: 7 },
};

// ------------------------------------------------------------------ the greater amberjack

/** Seriola dumerili: a long, fusiform jack, a low soft dorsal fin along the back, a deeply forked
 * tail, an amber stripe from the eye to the tail and a dark band across the nape (tidewater's jack,
 * slimmed to an amberjack's depth). */
export const AMBERJACK: Anatomy = {
	body: 0.8, sec: 2.0,
	top: [ [ 0, 0.004 ], [ 0.03, 0.022 ], [ 0.08, 0.048 ], [ 0.16, 0.074 ], [ 0.28, 0.094 ], [ 0.42, 0.098 ], [ 0.56, 0.088 ], [ 0.7, 0.066 ], [ 0.84, 0.036 ], [ 0.94, 0.021 ], [ 1, 0.018 ] ],
	bot: [ [ 0, 0.004 ], [ 0.03, 0.018 ], [ 0.08, 0.04 ], [ 0.16, 0.064 ], [ 0.28, 0.082 ], [ 0.42, 0.087 ], [ 0.56, 0.078 ], [ 0.7, 0.058 ], [ 0.84, 0.032 ], [ 0.94, 0.019 ], [ 1, 0.017 ] ],
	wid: [ [ 0, 0.004 ], [ 0.05, 0.022 ], [ 0.15, 0.04 ], [ 0.3, 0.048 ], [ 0.5, 0.044 ], [ 0.7, 0.032 ], [ 0.88, 0.02 ], [ 1, 0.016 ] ],
	dorsal: [
		{ from: 0.34, to: 0.42, rays: 5, h: [ [ 0, 0.03 ], [ 1, 0.015 ] ], rake: [ 0.4, 0.7 ], notch: 0.15 },
		{ from: 0.44, to: 0.84, rays: 12, h: [ [ 0, 0.06 ], [ 0.15, 0.045 ], [ 1, 0.02 ] ], rake: [ 0.55, 1.05 ], notch: 0.015 },
	],
	anal: [ { from: 0.6, to: 0.84, rays: 9, h: [ [ 0, 0.05 ], [ 0.15, 0.038 ], [ 1, 0.018 ] ], rake: [ 0.55, 1.05 ], notch: 0.015 } ],
	pectoral: { u: 0.29, y: - 0.01, rays: 7, lead: 1.0, last: 0.3, len: 0.15, tail: 0.45, dihedral: - 0.1 },
	pelvic: { u: 0.31, y: - 0.075, rays: 4, lead: 0.9, last: 0.4, len: 0.07, tail: 0.6, dihedral: - 0.1 },
	caudal: { len: 0.22, span: 0.19, fork: 0.25, lower: 1, rays: 15 },
};
export const AMBERJACK_SKIN: FishSkin = {
	back: 0x5a7088, flank: 0xbcc8d0, belly: 0xe6ecee, fin: 0x7c8a94, finEdge: 0x3c444c, iris: 0xc8c0a0,
	silver: 0.55, rough: 0.3,
	eye: { u: 0.07, y: 0.025, r: 0.018 },
	pattern: { kind: 'band', color: 0xb59a52, h: 0.05, width: 0.09 },
};

// ------------------------------------------------------------------ the Indo-Pacific bottlenose dolphin

/** Tursiops aduncus: a long, slim beak and a rounded melon, the falcate dorsal fin mid-back, the
 * flippers angled down behind the head, flukes some a quarter of the length across; its tail stock
 * tall and narrow. No anal or pelvic fins. */
export const DOLPHIN: Anatomy = {
	body: 0.87, sec: 2.05,
	top: [ [ 0, 0.008 ], [ 0.03, 0.016 ], [ 0.055, 0.028 ], [ 0.1, 0.068 ], [ 0.2, 0.098 ], [ 0.35, 0.115 ], [ 0.5, 0.11 ], [ 0.65, 0.088 ], [ 0.8, 0.055 ], [ 0.92, 0.03 ], [ 1, 0.018 ] ],
	bot: [ [ 0, 0.006 ], [ 0.03, 0.012 ], [ 0.06, 0.02 ], [ 0.1, 0.05 ], [ 0.2, 0.088 ], [ 0.35, 0.105 ], [ 0.5, 0.098 ], [ 0.65, 0.072 ], [ 0.8, 0.04 ], [ 0.92, 0.022 ], [ 1, 0.014 ] ],
	wid: [ [ 0, 0.006 ], [ 0.03, 0.012 ], [ 0.06, 0.02 ], [ 0.12, 0.055 ], [ 0.25, 0.086 ], [ 0.4, 0.09 ], [ 0.55, 0.076 ], [ 0.7, 0.05 ], [ 0.85, 0.024 ], [ 1, 0.012 ] ],
	dorsal: [ { from: 0.42, to: 0.58, rays: 7, h: [ [ 0, 0.11 ], [ 0.7, 0.07 ], [ 1, 0.01 ] ], rake: [ 0.55, 1.0 ], notch: 0 } ],
	anal: [],
	pectoral: { u: 0.2, y: - 0.06, rays: 5, lead: 1.05, last: 0.55, len: 0.14, tail: 0.45, dihedral: - 0.55 },
	pelvic: { u: 0, y: 0, rays: 0, lead: 0, last: 0, len: 0, tail: 0, dihedral: 0 },
	caudal: { len: 0.13, span: 0.125, fork: 0.65, lower: 1, rays: 9, flukes: true },
};
export const DOLPHIN_SKIN: FishSkin = {
	back: 0x383e42, flank: 0x5f676c, belly: 0xc9cbc8, fin: 0x363c40, finEdge: 0x2e3337, iris: 0x2a2620,
	silver: 0, rough: 0.35,
	eye: { u: 0.1, y: 0.0, r: 0.012 },
};

// ------------------------------------------------------------------ the whale shark

/** Rhincodon typus: the broad, flat head with the mouth across its front, the first dorsal fin
 * well back and a second one small, long pectoral fins, the tail's upper lobe the longer; pale
 * spots in rows between pale stripes over a dark grey back. */
export const WHALE_SHARK: Anatomy = {
	body: 0.74, sec: 2.3,
	top: [ [ 0, 0.02 ], [ 0.03, 0.05 ], [ 0.1, 0.074 ], [ 0.2, 0.094 ], [ 0.35, 0.108 ], [ 0.5, 0.1 ], [ 0.65, 0.076 ], [ 0.8, 0.046 ], [ 1, 0.028 ] ],
	bot: [ [ 0, 0.02 ], [ 0.03, 0.045 ], [ 0.1, 0.068 ], [ 0.2, 0.088 ], [ 0.35, 0.098 ], [ 0.5, 0.085 ], [ 0.65, 0.06 ], [ 0.8, 0.034 ], [ 1, 0.024 ] ],
	wid: [ [ 0, 0.04 ], [ 0.03, 0.072 ], [ 0.1, 0.09 ], [ 0.25, 0.1 ], [ 0.4, 0.094 ], [ 0.55, 0.074 ], [ 0.7, 0.05 ], [ 0.85, 0.03 ], [ 1, 0.02 ] ],
	dorsal: [
		{ from: 0.5, to: 0.63, rays: 6, h: [ [ 0, 0.1 ], [ 0.6, 0.07 ], [ 1, 0.01 ] ], rake: [ 0.6, 1.1 ], notch: 0 },
		{ from: 0.82, to: 0.87, rays: 3, h: [ [ 0, 0.035 ], [ 1, 0.01 ] ], rake: [ 0.6, 1.0 ], notch: 0 },
	],
	anal: [ { from: 0.82, to: 0.87, rays: 3, h: [ [ 0, 0.03 ], [ 1, 0.01 ] ], rake: [ 0.6, 1.0 ], notch: 0 } ],
	pectoral: { u: 0.27, y: - 0.06, rays: 6, lead: 1.1, last: 0.45, len: 0.17, tail: 0.4, dihedral: - 0.25 },
	pelvic: { u: 0.62, y: - 0.075, rays: 3, lead: 0.9, last: 0.45, len: 0.05, tail: 0.6, dihedral: - 0.15 },
	caudal: { len: 0.27, span: 0.2, fork: 0.45, lower: 0.62, rays: 13 },
};
export const WHALE_SHARK_SKIN: FishSkin = {
	back: 0x3d4d58, flank: 0x55636c, belly: 0xdcdfd9, fin: 0x36444e, finEdge: 0x2c3840, iris: 0x1a1c1c,
	silver: 0, rough: 0.6,
	eye: { u: 0.06, y: 0.01, r: 0.008 },
	pattern: { kind: 'chequer', color: 0xc9d0cc },
};

// ------------------------------------------------------------------ the reef's fish

/** Chromis notata, the pearl-spot chromis: a small, deep, compressed damselfish, one long dorsal
 * fin, a deeply forked tail; dark olive brown, paler below, a white spot under the end of the
 * dorsal fin. Hovers in aggregations over the rocky reef, picking plankton. */
export const CHROMIS: Anatomy = {
	body: 0.77, sec: 2.2,
	top: [ [ 0, 0.01 ], [ 0.04, 0.05 ], [ 0.12, 0.11 ], [ 0.26, 0.16 ], [ 0.42, 0.165 ], [ 0.6, 0.13 ], [ 0.78, 0.075 ], [ 0.9, 0.05 ], [ 1, 0.045 ] ],
	bot: [ [ 0, 0.01 ], [ 0.04, 0.04 ], [ 0.12, 0.09 ], [ 0.26, 0.135 ], [ 0.42, 0.145 ], [ 0.6, 0.12 ], [ 0.78, 0.07 ], [ 0.9, 0.045 ], [ 1, 0.04 ] ],
	wid: [ [ 0, 0.01 ], [ 0.06, 0.035 ], [ 0.2, 0.052 ], [ 0.4, 0.05 ], [ 0.7, 0.032 ], [ 1, 0.014 ] ],
	dorsal: [ { from: 0.3, to: 0.86, rays: 14, h: [ [ 0, 0.06 ], [ 0.5, 0.075 ], [ 0.8, 0.1 ], [ 1, 0.04 ] ], rake: [ 0.45, 0.95 ], notch: 0.02 } ],
	anal: [ { from: 0.62, to: 0.86, rays: 9, h: [ [ 0, 0.05 ], [ 0.7, 0.09 ], [ 1, 0.035 ] ], rake: [ 0.5, 0.95 ], notch: 0.015 } ],
	pectoral: { u: 0.3, y: - 0.01, rays: 7, lead: 1.0, last: 0.35, len: 0.16, tail: 0.6, dihedral: 0 },
	pelvic: { u: 0.33, y: - 0.12, rays: 4, lead: 0.9, last: 0.45, len: 0.12, tail: 0.5, dihedral: - 0.2 },
	caudal: { len: 0.23, span: 0.2, fork: 0.35, lower: 1, rays: 13 },
};
export const CHROMIS_SKIN: FishSkin = {
	back: 0x2e2c22, flank: 0x4a4434, belly: 0x847a64, fin: 0x2c2a22, finEdge: 0x1c1a16, iris: 0x3a3426,
	silver: 0.1, rough: 0.42,
	eye: { u: 0.085, y: 0.04, r: 0.03 },
	marks: [ { kind: 'spot', u: 0.6, y: 0.1, r: 0.03, color: 0xe8e8e0 } ],
};

/** Chaetodon auripes, the oriental butterflyfish: a disc-deep, very compressed body, a pointed
 * snout, long dorsal and anal fins, a squarish tail; golden yellow with fine dark lines along the
 * scale rows, a black bar through the eye with a white one behind it. Mostly in pairs, picking at
 * the reef. */
export const BUTTERFLYFISH: Anatomy = {
	body: 0.84, sec: 2.3,
	top: [ [ 0, 0.008 ], [ 0.05, 0.035 ], [ 0.12, 0.1 ], [ 0.25, 0.2 ], [ 0.42, 0.24 ], [ 0.6, 0.215 ], [ 0.78, 0.13 ], [ 0.9, 0.06 ], [ 1, 0.05 ] ],
	bot: [ [ 0, 0.008 ], [ 0.05, 0.03 ], [ 0.12, 0.085 ], [ 0.25, 0.18 ], [ 0.42, 0.215 ], [ 0.6, 0.19 ], [ 0.78, 0.115 ], [ 0.9, 0.055 ], [ 1, 0.045 ] ],
	wid: [ [ 0, 0.008 ], [ 0.08, 0.028 ], [ 0.25, 0.042 ], [ 0.45, 0.04 ], [ 0.7, 0.026 ], [ 1, 0.012 ] ],
	dorsal: [ { from: 0.3, to: 0.9, rays: 15, h: [ [ 0, 0.05 ], [ 0.5, 0.07 ], [ 0.8, 0.075 ], [ 1, 0.03 ] ], rake: [ 0.6, 1.1 ], notch: 0.015 } ],
	anal: [ { from: 0.58, to: 0.9, rays: 10, h: [ [ 0, 0.05 ], [ 0.6, 0.075 ], [ 1, 0.03 ] ], rake: [ 0.6, 1.1 ], notch: 0.015 } ],
	pectoral: { u: 0.32, y: - 0.02, rays: 6, lead: 1.0, last: 0.35, len: 0.12, tail: 0.6, dihedral: 0 },
	pelvic: { u: 0.36, y: - 0.17, rays: 4, lead: 0.9, last: 0.45, len: 0.1, tail: 0.5, dihedral: - 0.2 },
	caudal: { len: 0.16, span: 0.17, fork: 1, lower: 1, rays: 11 },
};
export const BUTTERFLYFISH_SKIN: FishSkin = {
	back: 0xb88c2e, flank: 0xd0a43a, belly: 0xd8b85a, fin: 0xc49a34, finEdge: 0x3a2a14, iris: 0x1a1612,
	silver: 0, rough: 0.4,
	eye: { u: 0.11, y: 0.045, r: 0.025 },
	pattern: { kind: 'stripes', color: 0x6a4c1e, count: 9 },
	marks: [ { kind: 'bar', from: 0.085, to: 0.14, color: 0x16140f }, { kind: 'bar', from: 0.14, to: 0.17, color: 0xe6e0d0 } ],
};

/** Oplegnathus fasciatus, the barred knifejaw: a deep, compressed body, the teeth fused into a
 * parrot-like beak, a spiny dorsal fin running into the soft one; grey white under seven black bars,
 * the first through the eye. Alone or a few together, crushing urchins and shellfish off the
 * stones. */
export const KNIFEJAW: Anatomy = {
	body: 0.82, sec: 2.2,
	top: [ [ 0, 0.012 ], [ 0.04, 0.05 ], [ 0.12, 0.12 ], [ 0.26, 0.18 ], [ 0.42, 0.19 ], [ 0.6, 0.165 ], [ 0.78, 0.1 ], [ 0.9, 0.065 ], [ 1, 0.058 ] ],
	bot: [ [ 0, 0.012 ], [ 0.04, 0.045 ], [ 0.12, 0.1 ], [ 0.26, 0.155 ], [ 0.42, 0.17 ], [ 0.6, 0.145 ], [ 0.78, 0.09 ], [ 0.9, 0.06 ], [ 1, 0.052 ] ],
	wid: [ [ 0, 0.012 ], [ 0.06, 0.04 ], [ 0.2, 0.062 ], [ 0.42, 0.06 ], [ 0.7, 0.04 ], [ 1, 0.018 ] ],
	dorsal: [ { from: 0.28, to: 0.86, rays: 15, h: [ [ 0, 0.055 ], [ 0.2, 0.08 ], [ 0.55, 0.045 ], [ 0.75, 0.085 ], [ 1, 0.035 ] ], rake: [ 0.5, 1.0 ], notch: 0.03 } ],
	anal: [ { from: 0.62, to: 0.86, rays: 9, h: [ [ 0, 0.05 ], [ 0.5, 0.085 ], [ 1, 0.035 ] ], rake: [ 0.5, 1.0 ], notch: 0.015 } ],
	pectoral: { u: 0.3, y: - 0.03, rays: 7, lead: 1.0, last: 0.35, len: 0.14, tail: 0.6, dihedral: 0 },
	pelvic: { u: 0.34, y: - 0.14, rays: 4, lead: 0.9, last: 0.45, len: 0.1, tail: 0.5, dihedral: - 0.2 },
	caudal: { len: 0.18, span: 0.17, fork: 0.85, lower: 1, rays: 13 },
};
const KNIFEJAW_BAR = 0x1e2022;
export const KNIFEJAW_SKIN: FishSkin = {
	back: 0x9a9e98, flank: 0xc4c6be, belly: 0xd6d6cc, fin: 0x5a5e5c, finEdge: 0x2a2c2c, iris: 0x2a2a24,
	silver: 0.15, rough: 0.38,
	eye: { u: 0.085, y: 0.05, r: 0.022 },
	marks: [ [ 0.07, 0.115 ], [ 0.19, 0.25 ], [ 0.32, 0.38 ], [ 0.44, 0.5 ], [ 0.56, 0.61 ], [ 0.67, 0.71 ], [ 0.77, 0.81 ] ]
		.map( ( [ from, to ] ) => ( { kind: 'bar' as const, from, to, color: KNIFEJAW_BAR } ) ),
};

// ------------------------------------------------------------------ the rays and the turtle

/** Hemitrygon akajei, the red stingray: a brown back, its rim more orange, a pale belly. */
export const STINGRAY_SKIN = { back: 0x7a5a3a, mottle: 0x5f4630, margin: 0xa06a3c, belly: 0xe2d6c8, rough: 0.55 };
/** Aetobatus narutobiei: the Naruto eagle ray's plain dark brown back, its belly white. */
export const EAGLE_RAY_SKIN = { back: 0x3d3a30, mottle: 0x34312a, margin: 0x2e2b24, belly: 0xe0e2de, rough: 0.4 };
/** Chelonia mydas, the green turtle: an olive-brown carapace streaked darker, its skin dark scales
 * edged pale, a cream plastron. */
export const TURTLE_SKIN = { shell: 0x5a4a2c, streak: 0x2e2416, skin: 0x4a4636, scale: 0xb8ae90, plastron: 0xd6c898 };

// ------------------------------------------------------------------ the moon jelly

/** Aurelia aurita: the clear bell faintly blue grey, its margin milky, the four gonads lilac pink
 * rings, the oral arms pale; the bell's clearness is the painter's coverage (jellySkin). */
export const JELLY_SKIN = { bell: 0x8c9ca6, margin: 0xb0bec6, gonad: 0xb48cb4, arm: 0xa4a2b4, rough: 0.22 };
