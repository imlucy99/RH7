/* =========================================================
   JGVRP Speedometer HUD  (cluster analog RH-7: HSW tacho + speedo + fuel)
   API (dipanggil dari game / CEF):
     setSpeed(m/s)            setRPM(0.0 - 1.0)   (1.0 = RPM_FULL x1000 rpm)
     setFuel(0-1 | 0-100)     setHealth(0-1 | 0-1000)  -> jarum OIL PSI (di dalam gauge RPM)
     setGear(n)               setHeadlights(0 off | 1 low | 2 high)
     setSeatbelts(bool)       updateLockStatus(state)
     setOdometer(miles)       setEngine(bool)
   Efek:
     setEngine(true)  -> dial terang, ODO LCD menyala + jarum menyapu (kontak ON)
     setEngine(false) -> muka dial redup, ODO LCD mati total seperti layar mati
     setHeadlights(1|2) -> semua jarum menyala (glow), seperti lampu dashboard asli
   ========================================================= */

const MPS_TO_MPH = 2.236936;
const MAX_MPH = 200;          // skala speedometer
const MAX_RPM = 11;           // skala tachometer (x1000), sesuai gambar 0-11
const RPM_FULL = 9;           // setRPM(1.0) = 9000 rpm (ubah kalau mau jarum lebih tinggi / rendah)
const REDLINE = 8;            // mulai zona merah (x1000)
const LIMITER = 0.96;         // RPM (0-1) mulai dianggap kena limiter -> jarum geter
const OIL_MAX = 120;          // skala oil PSI di dalam gauge RPM
const OIL_FULL_PSI = 60;      // setHealth penuh = 60 PSI (ubah kalau mau jarum lebih tinggi / rendah)

const NOOP_EL = document.createElement('div');   // pengaman kalau ada elemen yang dihapus dari HTML
const $ = (id) => document.getElementById(id) || NOOP_EL;
const elHud = $('hud');
const svg = $('dial');

function isLockedState(val) {
    return val === true || val === 1 || val === '1' || val === 'true' || val === 2 || val === '2';
}
function isTrueValue(val) {
    return val === true || val === 1 || val === '1' || val === 'true';
}
const clamp01 = (v) => Math.max(0, Math.min(1, v));

// ---------- Geometri (koordinat mengikuti gambar referensi 1964x801) ----------
const SPD  = { cx: 1032, cy: 390, bezel: 286, ring: 270, face: 260, a0: 150, sweep: 240 };
const RPM  = { cx: 495,  cy: 398, bezel: 270, ring: 254, face: 238, a0: 150, sweep: 240 };
// fuel: busur berpusat di (cx,cy); jarum berputar di hub (hx,hy) lalu diarahkan ke titik busur
const FUEL = { cx: 1536, cy: 437, bezel: 196, ring: 182, face: 170, a0: 135, sweep: 135, hx: 1592, hy: 403, aimR: 150 };
// oil PSI: busur berpusat di bawah (cx,cy), jarum berputar di hub kecil (hx,hy)
const OIL  = { cx: RPM.cx, cy: 655, dome: 192, a0: 220, sweep: 100, hx: RPM.cx, hy: 600, aimR: 165 };

// ---------- Tata letak: 3 gauge satu garis tengah, jarak antar bezel sama, dibungkus satu rumah ----------
// (geometri di atas tetap dalam koordinat lokal; tiap gauge digeser ke posisi akhirnya lewat <g transform>)
const LAYOUT = { x: 200, midY: 390, pad: 34, gap: 18, rx: 120 };
const FRAME = {
    x: LAYOUT.x, y: LAYOUT.midY - SPD.bezel - LAYOUT.pad, r: LAYOUT.rx,
    w: LAYOUT.pad * 2 + LAYOUT.gap * 2 + (RPM.bezel + SPD.bezel + FUEL.bezel) * 2,
    h: (SPD.bezel + LAYOUT.pad) * 2,
};
const SHIFT = (() => {
    const rpmL = LAYOUT.x + LAYOUT.pad;                       // tepi kiri bezel RPM
    const spdL = rpmL + RPM.bezel * 2 + LAYOUT.gap;           // tepi kiri bezel speedo
    const fuelL = spdL + SPD.bezel * 2 + LAYOUT.gap;          // tepi kiri bezel fuel
    return {
        rpm:  [rpmL + RPM.bezel - RPM.cx,   LAYOUT.midY - RPM.cy],
        spd:  [spdL + SPD.bezel - SPD.cx,   LAYOUT.midY - SPD.cy],
        fuel: [fuelL + FUEL.bezel - FUEL.cx, LAYOUT.midY - FUEL.cy],
    };
})();
const VIEW = [FRAME.x - 14, FRAME.y - 14, FRAME.w + 28, FRAME.h + 28];
svg.setAttribute('viewBox', VIEW.join(' '));

const pol = (cx, cy, r, a) => {
    const t = (a * Math.PI) / 180;
    return [(cx + r * Math.cos(t)).toFixed(2), (cy + r * Math.sin(t)).toFixed(2)];
};
function sector(cx, cy, r1, r2, a1, a2) {
    const [x1, y1] = pol(cx, cy, r2, a1), [x2, y2] = pol(cx, cy, r2, a2);
    const [x3, y3] = pol(cx, cy, r1, a2), [x4, y4] = pol(cx, cy, r1, a1);
    const large = a2 - a1 > 180 ? 1 : 0;
    return `M${x1} ${y1}A${r2} ${r2} 0 ${large} 1 ${x2} ${y2}L${x3} ${y3}A${r1} ${r1} 0 ${large} 0 ${x4} ${y4}Z`;
}
function arcPath(cx, cy, r, a1, a2) {
    const [x1, y1] = pol(cx, cy, r, a1), [x2, y2] = pol(cx, cy, r, a2);
    return `M${x1} ${y1}A${r} ${r} 0 ${Math.abs(a2 - a1) > 180 ? 1 : 0} ${a2 > a1 ? 1 : 0} ${x2} ${y2}`;
}
const tick = (cx, cy, a, r1, r2, w, cls) => {
    const [x1, y1] = pol(cx, cy, r1, a), [x2, y2] = pol(cx, cy, r2, a);
    return `<line class="${cls || 'tk'}" x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke-width="${w}"/>`;
};
const txt = (cls, x, y, size, s) => `<text class="${cls}" x="${x}" y="${y}" font-size="${size}">${s}</text>`;

// Bezel hitam + ring krom tipis + muka dial putih
function bezelFace(g) {
    return `
    <circle cx="${g.cx}" cy="${g.cy}" r="${g.bezel}" fill="url(#bezelG)"/>
    <circle cx="${g.cx}" cy="${g.cy}" r="${g.bezel - 2}" fill="none" stroke="rgba(255,255,255,0.16)" stroke-width="2"/>
    <circle cx="${g.cx}" cy="${g.cy}" r="${g.bezel - 15}" fill="#050506"/>
    <circle cx="${g.cx}" cy="${g.cy}" r="${g.ring}" fill="none" stroke="url(#chrome)" stroke-width="5"/>
    <circle cx="${g.cx}" cy="${g.cy}" r="${g.ring - 4}" fill="#09090a"/>
    <circle cx="${g.cx}" cy="${g.cy}" r="${g.face}" fill="url(#faceG)"/>
    <circle cx="${g.cx}" cy="${g.cy}" r="${g.face - 6}" fill="none" stroke="rgba(0,0,0,0.09)" stroke-width="12"/>`;
}
const shade = (g) => `<circle class="shade" cx="${g.cx}" cy="${g.cy}" r="${g.face}"/>`;

// Jarum merah meruncing + hub hitam. L = panjang dasar, tail = ekor di belakang hub
function needle(id, x, y, L, tail, w0, hubR) {
    return `
    <g id="${id}" transform="translate(${x} ${y}) rotate(0) scale(1 1)">
      <path class="ndl" d="M${-tail} ${-w0 * 0.7}L0 ${-w0}L${L} -1.3L${L} 1.3L0 ${w0}L${-tail} ${w0 * 0.7}Z"/>
      <path class="ndl-hi" d="M${-tail + 8} ${-w0 * 0.3}L${L - 10} -0.3"/>
    </g>
    <circle cx="${x}" cy="${y}" r="${hubR}" fill="url(#hubG)"/>
    <circle class="hub-ring" cx="${x}" cy="${y}" r="${hubR - 1}"/>
    <circle cx="${x}" cy="${y}" r="${hubR}" fill="none" stroke="rgba(255,255,255,0.14)" stroke-width="2"/>
    <ellipse cx="${x - hubR * 0.22}" cy="${y - hubR * 0.45}" rx="${hubR * 0.5}" ry="${hubR * 0.2}" fill="rgba(255,255,255,0.09)"/>`;
}

// Ikon (viewBox 24x24) ditaruh di (x,y) dengan skala s
const icon = (id, cls, x, y, s, inner) =>
    `<g id="${id}" class="ind ${cls}" transform="translate(${x} ${y}) scale(${s})" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${inner}</g>`;

const ICON_HEADLIGHT = `
    <path d="M12 4h2a8 8 0 0 1 0 16h-2z" fill="currentColor" fill-opacity=".15"/>
    <g class="beam-low"><path d="M9 5L2 7.5M9 9L2 11.5M9 13L2 15.5M9 17L2 19.5"/></g>
    <g class="beam-high"><path d="M9 6H2M9 10H2M9 14H2M9 18H2"/></g>`;
const ICON_SEATBELT = `
    <circle cx="12" cy="4" r="2.2" fill="currentColor" stroke="none"/>
    <path d="M8 22v-5.5L7 11.5C7 9.6 8.4 8 10.2 8h3.6C15.6 8 17 9.6 17 11.5l-1 5V22"/>
    <path d="M9 8.5l7.5 10"/>`;
const ICON_LOCK = `
    <rect x="5" y="11" width="14" height="10" rx="2" fill="currentColor" stroke="none"/>
    <circle cx="12" cy="15.2" r="1.4" fill="#f4f1ec" stroke="none"/>
    <path class="shackle-closed" d="M8 11V8a4 4 0 0 1 8 0v3"/>
    <path class="shackle-open" d="M8 11V8a4 4 0 0 1 7.4-2.1"/>`;
const ICON_FUEL = `<path fill="currentColor" stroke="none" d="M19.77 7.23l.01-.01-3.72-3.72L15 4.56l2.11 2.11c-.94.36-1.61 1.26-1.61 2.33 0 1.38 1.12 2.5 2.5 2.5.36 0 .69-.08 1-.21v7.21c0 .55-.45 1-1 1s-1-.45-1-1V14c0-1.1-.9-2-2-2h-1V5c0-1.1-.9-2-2-2H6c-1.1 0-2 .9-2 2v16h10v-7.5h1.5v5c0 1.38 1.12 2.5 2.5 2.5s2.5-1.12 2.5-2.5V9c0-.69-.28-1.32-.73-1.77zM12 10H6V5h6v5zm6 0c-.55 0-1-.45-1-1s.45-1 1-1 1 .45 1 1-.45 1-1 1z"/>`;
const ICON_OIL = `<path fill="currentColor" stroke="none" d="M2.5 10h4.2l1.3-2h2V6.5H8V5h6v1.5h-2V8h2.5l2 1.8 5-2.8 1 1.2-6.6 7.3H8.4L7 13H2.5zM20.2 14.6c0-.9 1.1-2.3 1.1-2.3s1.1 1.4 1.1 2.3c0 .6-.5 1.1-1.1 1.1s-1.1-.5-1.1-1.1z"/>`;

// ---------- ODO LCD 7-segment (6 digit: 5 digit + 1 desimal) ----------
const ODO_N = 6;
const LCD = { x0: SPD.cx - 74, y: 530, pitch: 25, sc: 0.74 };   // 6 digit tepat di tengah speedo
const SEG_ON = ['abcdef', 'bc', 'abdeg', 'abcdg', 'bcfg', 'acdfg', 'acdefg', 'abc', 'abcdefg', 'abcdfg'];
function segPolys() {
    const xl = 3, xr = 23, yt = 3, ym = 21, yb = 39, t = 4.6, g = 2.4;
    const h = (x, y, l) => `${x},${y} ${x + t / 2},${y - t / 2} ${x + l - t / 2},${y - t / 2} ${x + l},${y} ${x + l - t / 2},${y + t / 2} ${x + t / 2},${y + t / 2}`;
    const v = (x, y, l) => `${x},${y} ${x + t / 2},${y + t / 2} ${x + t / 2},${y + l - t / 2} ${x},${y + l} ${x - t / 2},${y + l - t / 2} ${x - t / 2},${y + t / 2}`;
    const lh = xr - xl - 2 * g, lv = ym - yt - 2 * g;
    return {
        a: h(xl + g, yt, lh), g: h(xl + g, ym, lh), d: h(xl + g, yb, lh),
        f: v(xl, yt + g, lv), b: v(xr, yt + g, lv), e: v(xl, ym + g, lv), c: v(xr, ym + g, lv),
    };
}

function buildDial() {
    const sA = (v) => SPD.a0 + (v / MAX_MPH) * SPD.sweep;      // sudut speedo
    const rA = (v) => RPM.a0 + (v / MAX_RPM) * RPM.sweep;       // sudut tacho
    const oA = (v) => OIL.a0 + (v / OIL_MAX) * OIL.sweep;       // sudut oil PSI
    let s = `
    <defs>
      <linearGradient id="chrome" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0" stop-color="#ffffff"/><stop offset="0.35" stop-color="#6c6f76"/>
        <stop offset="0.65" stop-color="#2a2b2f"/><stop offset="1" stop-color="#d9dbe0"/>
      </linearGradient>
      <linearGradient id="bezelG" x1="0" y1="0" x2="0.4" y2="1">
        <stop offset="0" stop-color="#46484e"/><stop offset="0.35" stop-color="#17181b"/><stop offset="1" stop-color="#050506"/>
      </linearGradient>
      <radialGradient id="faceG" cx="0.5" cy="0.5" r="0.5">
        <stop offset="0.5" style="stop-color:var(--face-a)"/><stop offset="1" style="stop-color:var(--face-b)"/>
      </radialGradient>
      <radialGradient id="hubG" cx="0.4" cy="0.35" r="0.75">
        <stop offset="0" stop-color="#3a3b40"/><stop offset="0.6" stop-color="#0c0c0e"/><stop offset="1" stop-color="#030304"/>
      </radialGradient>
      <linearGradient id="domeG" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stop-color="#202125"/><stop offset="0.5" stop-color="#0b0b0d"/><stop offset="1" stop-color="#030304"/>
      </linearGradient>
      <linearGradient id="lcdOn" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stop-color="#454e41"/><stop offset="1" stop-color="#232a22"/>
      </linearGradient>
      <linearGradient id="lcdOff" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stop-color="#121314"/><stop offset="1" stop-color="#060707"/>
      </linearGradient>
      <linearGradient id="gloss" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stop-color="#fff" stop-opacity="0.16"/><stop offset="1" stop-color="#fff" stop-opacity="0"/>
      </linearGradient>
      <linearGradient id="housingG" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stop-color="#1c1d21"/><stop offset="0.5" stop-color="#0e0e10"/><stop offset="1" stop-color="#060607"/>
      </linearGradient>
      <clipPath id="tachClip"><circle cx="${RPM.cx}" cy="${RPM.cy}" r="${RPM.face}"/></clipPath>
    </defs>
`;

    // ----- rumah / frame: membungkus ketiga gauge dengan padding & jarak yang sama -----
    s += `<rect x="${FRAME.x}" y="${FRAME.y}" width="${FRAME.w}" height="${FRAME.h}" rx="${FRAME.r}" fill="url(#housingG)"/>
    <rect x="${FRAME.x + 1}" y="${FRAME.y + 1}" width="${FRAME.w - 2}" height="${FRAME.h - 2}" rx="${FRAME.r - 1}" fill="none" stroke="rgba(255,255,255,0.12)" stroke-width="2"/>
    <rect x="${FRAME.x + 10}" y="${FRAME.y + 10}" width="${FRAME.w - 20}" height="${FRAME.h - 20}" rx="${FRAME.r - 10}" fill="none" stroke="rgba(0,0,0,0.6)" stroke-width="3"/>`;

    // tiap gauge digambar utuh (bezel, skala, ikon, jarum) lalu digeser ke posisinya
    const place = (k, inner) => `<g transform="translate(${SHIFT[k][0]} ${SHIFT[k][1]})">${inner}</g>`;

    // =================== TACHO 0-11, zona merah 8-11 (kiri) ===================
    let t = bezelFace(RPM);
    t += `<path class="zone" d="${sector(RPM.cx, RPM.cy, 190, 224, rA(REDLINE), rA(MAX_RPM))}"/>`;
    for (let i = 0; i <= 55; i++) {
        const a = rA(i * 0.2), major = i % 5 === 0, inRed = i >= REDLINE * 5;
        t += tick(RPM.cx, RPM.cy, a, major ? 190 : 208, 224, major ? 4.6 : 2.4, inRed ? 'tkw' : 'tk');
    }
    for (let v = 0; v <= MAX_RPM; v++) {
        const [x, y] = pol(RPM.cx, RPM.cy, 150, rA(v));
        t += txt('num', x, y, 40, v);
    }
    t += txt('brand', RPM.cx, RPM.cy - 98, 34, 'HSW') + txt('lbl', RPM.cx, RPM.cy - 67, 19, 'x1000');

    // OIL PSI: kubah hitam di dalam gauge RPM (jarum = setHealth), hub di tengah, ikon & PSI simetris di kiri/kanan hub
    t += `<g clip-path="url(#tachClip)">
      <circle cx="${OIL.cx}" cy="${OIL.cy}" r="${OIL.dome}" fill="url(#domeG)"/>
      <circle cx="${OIL.cx}" cy="${OIL.cy}" r="${OIL.dome - 3}" fill="none" stroke="url(#chrome)" stroke-width="5" opacity="0.9"/>
      <path class="dred" d="${arcPath(OIL.cx, OIL.cy, 177, oA(105), oA(OIL_MAX))}"/>`;
    for (let p = 0; p <= OIL_MAX; p += 5) {
        const major = p % 30 === 0, mid = p % 15 === 0, red = p >= 105;
        t += tick(OIL.cx, OIL.cy, oA(p), major ? 160 : mid ? 164 : 167, 174, major ? 3.4 : mid ? 2.4 : 1.6, red ? 'dtk red' : 'dtk');
    }
    for (let p = 0; p <= OIL_MAX; p += 30) {
        const [x, y] = pol(OIL.cx, OIL.cy, 146, oA(p));
        t += txt('dnum', x, y, 27, p);
    }
    t += txt('dlbl', OIL.hx + 64, OIL.hy, 17, 'PSI') + `</g>`;
    t += shade(RPM);
    t += icon('oil-ico', 'gauge-ico lt', OIL.hx - 64 - 16.8, OIL.hy - 16.8, 1.4, ICON_OIL);
    t += `<circle cx="${RPM.cx - 78}" cy="${RPM.cy}" r="8" fill="url(#hubG)"/><circle cx="${RPM.cx + 78}" cy="${RPM.cy}" r="8" fill="url(#hubG)"/>`;
    t += needle('nd-oil', OIL.hx, OIL.hy, 140, 26, 3.8, 18);
    t += needle('nd-rpm', RPM.cx, RPM.cy, 215, 62, 7.5, 41);
    s += place('rpm', t);

    // =================== SPEEDO 0-200 + ODO (tengah) ===================
    let v = bezelFace(SPD);
    for (let i = 0; i <= 50; i++) {
        const major = i % 5 === 0;
        v += tick(SPD.cx, SPD.cy, sA(i * 4), major ? 214 : 234, 252, major ? 5 : 2.4);
    }
    for (let n = 0; n <= MAX_MPH; n += 20) {
        const [x, y] = pol(SPD.cx, SPD.cy, 186, sA(n));
        v += txt('num', x, y, 40, n);
    }
    v += `<text class="brand" x="${SPD.cx + 4}" y="${SPD.cy - 90}" font-size="40">RH-<tspan class="brand-red">7</tspan></text>`;
    v += txt('lbl mph-lbl', SPD.cx, SPD.cy - 52, 18, 'MPH');
    v += shade(SPD);

    // gear + 3 ikon status: 4 slot berjarak sama, dipusatkan di bawah hub speedo
    const ROW_Y = SPD.cy + 82, SLOT = 52, IC = 1.4 * 12;     // IC = setengah lebar ikon
    v += `<text id="gear" class="gear" x="${SPD.cx - SLOT * 1.5}" y="${ROW_Y}">N</text>`;
    v += icon('headlight', 'eng', SPD.cx - SLOT * 0.5 - IC, ROW_Y - IC, 1.4, ICON_HEADLIGHT);
    v += icon('seatbelts', 'eng warn', SPD.cx + SLOT * 0.5 - IC, ROW_Y - IC, 1.4, ICON_SEATBELT);
    v += icon('door-lock', '', SPD.cx + SLOT * 1.5 - IC, ROW_Y - IC, 1.4, ICON_LOCK);

    // ODO digital LCD (dipusatkan di speedo): mati total saat mesin off
    const SEGS = segPolys();
    let digits = '';
    for (let i = 0; i < ODO_N; i++) {
        const x = LCD.x0 + i * LCD.pitch;
        let g = '';
        for (const k of 'abcdefg') g += `<polygon class="seg-ghost" points="${SEGS[k]}"/>`;
        for (const k of 'abcdefg') g += `<polygon class="seg" id="sg${i}${k}" points="${SEGS[k]}"/>`;
        digits += `<g transform="translate(${x + 2} ${LCD.y}) skewX(-7) scale(${LCD.sc})">${g}</g>`;
    }
    const lx = SPD.cx - 123.5;
    v += `<g class="lcd">
      <rect x="${lx}" y="513" width="247" height="65" rx="8" fill="#0b0c0d"/>
      <rect x="${lx + 5}" y="518" width="237" height="55" rx="4" fill="url(#lcdOff)"/>
      <g class="lcd-live">
        <rect x="${lx + 5}" y="518" width="237" height="55" rx="4" fill="url(#lcdOn)"/>
        <g class="lcd-digits">${digits}<circle class="lcd-dot" cx="${LCD.x0 + 4 * LCD.pitch + 22}" cy="${LCD.y + 29}" r="1.6"/></g>
      </g>
      <rect x="${lx + 5}" y="518" width="237" height="24" rx="4" fill="url(#gloss)"/>
    </g>`;
    v += `<circle cx="${SPD.cx - 88}" cy="${SPD.cy}" r="8" fill="url(#hubG)"/><circle cx="${SPD.cx + 88}" cy="${SPD.cy}" r="8" fill="url(#hubG)"/>`;
    v += needle('nd-spd', SPD.cx, SPD.cy, 240, 72, 8, 44);
    s += place('spd', v);

    // =================== FUEL F/E (kanan) ===================
    let f = bezelFace(FUEL);
    f += `<path class="zone" d="${sector(FUEL.cx, FUEL.cy, 132, 166, FUEL.a0, FUEL.a0 + 17)}"/>`;
    for (let k = 0; k <= 6; k++) {
        const major = k % 2 === 0;
        f += tick(FUEL.cx, FUEL.cy, FUEL.a0 + k * 22.5, major ? 127 : 145, 165, major ? 5 : 2.6);
    }
    f += txt('num', FUEL.cx + 2, FUEL.cy - 96, 38, 'F') + txt('num', FUEL.cx + 2, FUEL.cy + 96, 38, 'E');
    f += shade(FUEL);
    f += icon('fuel-ico', 'gauge-ico', FUEL.cx - 28 - 22.8, FUEL.cy - 6 - 22.8, 1.9, ICON_FUEL);
    f += needle('nd-fuel', FUEL.hx, FUEL.hy, 200, 42, 5.5, 38);
    s += place('fuel', f);

    svg.innerHTML = s;
}
buildDial();

const ndSpd = $('nd-spd'), ndRpm = $('nd-rpm'), ndFuel = $('nd-fuel'), ndOil = $('nd-oil');
const ang = {};
function setNeedle(el, key, x, y, a, sx) {
    const k = a.toFixed(2) + '|' + sx.toFixed(3);
    if (ang[key] === k) return;                                   // tulis hanya kalau jarum benar-benar bergerak
    ang[key] = k;
    el.setAttribute('transform', `translate(${x} ${y}) rotate(${a.toFixed(2)}) scale(${sx.toFixed(3)} 1)`);
}
// Jarum yang pivotnya tidak di pusat busur: arahkan ke titik pada busur, panjang menyesuaikan jarak
function aimNeedle(el, key, hx, hy, cx, cy, r, a, baseL) {
    const [tx, ty] = pol(cx, cy, r, a);
    const dx = tx - hx, dy = ty - hy;
    setNeedle(el, key, hx, hy, (Math.atan2(dy, dx) * 180) / Math.PI, Math.hypot(dx, dy) / baseL);
}
// Helper kelas untuk elemen SVG (className SVG bukan string biasa)
function setCls(el, cls) { if (el.getAttribute('class') !== cls) el.setAttribute('class', cls); }
function setText(el, t) { t = String(t); if (el.textContent !== t) el.textContent = t; }

// ---------- State ----------
const state = {
    mph: 0, mps: 0,
    rpm: 0, health: 1, fuel: 1,
    spdShown: 0, rpmShown: 0, fuelShown: 0, oilShown: 0,
    belted: false, engine: false, lights: 0,
};
const BOOT_MS = 1700;
let bootUntil = 0;

// ---------- Loop animasi (berhenti sendiri kalau semua jarum diam) ----------
const FRAME_MS = 1000 / 60;
let lastFrame = 0, rafId = 0;
function kick() {
    if (rafId) return;
    lastFrame = performance.now() - FRAME_MS;
    rafId = requestAnimationFrame(frame);
}
function frame(now) {
    rafId = 0;
    if (now - lastFrame < FRAME_MS - 2) { rafId = requestAnimationFrame(frame); return; }
    const dt = Math.min(0.1, (now - lastFrame) / 1000);
    lastFrame = now;

    // Sapuan jarum saat kontak ON: 0 -> max -> 0
    const booting = now < bootUntil;
    let sw = 0;
    if (booting) {
        const t = 1 - (bootUntil - now) / BOOT_MS;
        sw = t < 0.45 ? t / 0.45 : t < 0.55 ? 1 : Math.max(0, 1 - (t - 0.55) / 0.45);
    }

    const RPM_SPAN = MAX_RPM / RPM_FULL;            // sapuan boot menjangkau ujung skala 11
    const OIL_SPAN = OIL_MAX / OIL_FULL_PSI;        // sapuan boot menjangkau 120 PSI
    const tSpd = booting ? Math.max(sw, state.mph / MAX_MPH) : state.mph / MAX_MPH;
    const limiter = !booting && state.engine && state.rpm >= LIMITER;
    let tRpm = booting ? sw * RPM_SPAN : state.engine ? state.rpm : 0;
    if (limiter) {   // rev limiter: jarum mental-mental di dekat batas (fuel cut), seperti mobil asli
        const cut = Math.sin((now / 1000) * 2 * Math.PI * 11) > 0;
        tRpm = state.rpm - (cut ? 0.04 + Math.random() * 0.02 : Math.random() * 0.012);
    }
    const tFuel = booting ? Math.max(sw, state.fuel) : state.engine ? state.fuel : 0;
    const tOil = booting ? sw * OIL_SPAN : state.engine ? state.health : 0;

    const kf = booting ? 1 : Math.min(1, dt * (limiter ? 45 : 12)), ks = booting ? 1 : Math.min(1, dt * 4);
    const ease = (cur, tgt, k) => (Math.abs(tgt - cur) < 0.0004 ? tgt : cur + (tgt - cur) * k);
    state.spdShown = ease(state.spdShown, tSpd, kf);
    state.rpmShown = ease(state.rpmShown, tRpm, kf);
    state.fuelShown = ease(state.fuelShown, tFuel, ks);
    state.oilShown = ease(state.oilShown, tOil, ks);

    setNeedle(ndSpd, 'spd', SPD.cx, SPD.cy, SPD.a0 + clamp01(state.spdShown) * SPD.sweep, 1);
    const rv = Math.max(0, Math.min(MAX_RPM, state.rpmShown * RPM_FULL));
    setNeedle(ndRpm, 'rpm', RPM.cx, RPM.cy, RPM.a0 + (rv / MAX_RPM) * RPM.sweep, 1);
    aimNeedle(ndFuel, 'fuel', FUEL.hx, FUEL.hy, FUEL.cx, FUEL.cy, FUEL.aimR, FUEL.a0 + clamp01(state.fuelShown) * FUEL.sweep, 200);
    const psi = Math.max(0, Math.min(OIL_MAX, state.oilShown * OIL_FULL_PSI));
    aimNeedle(ndOil, 'oil', OIL.hx, OIL.hy, OIL.cx, OIL.cy, OIL.aimR, OIL.a0 + (psi / OIL_MAX) * OIL.sweep, 140);

    if (booting || limiter || state.spdShown !== tSpd || state.rpmShown !== tRpm || state.fuelShown !== tFuel || state.oilShown !== tOil) {
        rafId = requestAnimationFrame(frame);
    }
}

// ---------- 1. Kecepatan (m/s) ----------
window.setSpeed = function (speed) {
    state.mps = Number(speed || 0);
    state.mph = Math.round(state.mps * MPS_TO_MPH);
    kick();
};
// ---------- 2. RPM (0.0 - 1.0) ----------
window.setRPM = function (rpm) {
    const r = clamp01(Number(rpm || 0));
    if (r === state.rpm) return;
    state.rpm = r;
    kick();
};
// ---------- 3. Fuel ----------
window.setFuel = function (fuel) {
    const val = Number(fuel || 0);
    state.fuel = clamp01(val > 1 ? val / 100 : val);
    setCls($('fuel-ico'), state.fuel < 0.2 ? 'ind gauge-ico low' : 'ind gauge-ico');
    kick();
};
// ---------- 4. Engine health -> jarum OIL PSI (di dalam gauge RPM) ----------
window.setHealth = function (health) {
    const val = Number(health || 0);
    const p = clamp01(val > 1 ? val / 1000 : val);
    if (p === state.health) return;
    state.health = p;
    setCls($('oil-ico'), p <= 0.3 ? 'ind gauge-ico lt crit' : p <= 0.5 ? 'ind gauge-ico lt low' : 'ind gauge-ico lt');
    kick();
};
// ---------- 5. Gear ----------
window.setGear = function (gear) {
    let g = String(gear);
    if (gear == 0 || g === '0' || g.toUpperCase() === 'R') g = 'R';
    else if (gear === null || gear === undefined || g === '' || g.toUpperCase() === 'N') g = 'N';
    setText($('gear'), g);
    setCls($('gear'), g === 'R' ? 'gear rev' : 'gear');
};
// ---------- 6. Lock ----------
window.updateLockStatus = function (st) {
    setCls($('door-lock'), isLockedState(st) ? 'ind locked' : 'ind');
};
['setDoors', 'setDoorLock', 'setVehicleLocked', 'setLocked', 'setLock', 'toggleLock'].forEach((n) => { window[n] = window.updateLockStatus; });

// ---------- 7. LAMPU: 0 mati, 1 low, 2 high -> ikon + SEMUA JARUM MENYALA ----------
window.setHeadlights = function (st) {
    const val = Number(st || 0);
    state.lights = val;
    setCls($('headlight'), val === 2 ? 'ind eng high-beam' : val === 1 ? 'ind eng active' : 'ind eng');
    elHud.classList.toggle('lights-on', val > 0);
};
window.setLights = window.setHeadlights;
window.setLeftIndicator = function () {};     // sein dihapus
window.setRightIndicator = function () {};

// ---------- 8. Seatbelt ----------
window.setSeatbelts = function (val) {
    const on = isTrueValue(val);
    state.belted = on;
    setCls($('seatbelts'), on ? 'ind eng active' : 'ind eng warn');
};

// ---------- 9. Odometer (mil) -> LCD 7-segment: 5 digit + 1 digit desimal ----------
let lastOdo = '';
const odoSegs = [];
for (let i = 0; i < ODO_N; i++) {
    const o = {};
    for (const k of 'abcdefg') o[k] = $('sg' + i + k);
    odoSegs.push(o);
}
window.setOdometer = function (distance) {
    const n = Math.max(0, Math.min(999999, Math.floor(Number(distance || 0) * 10)));
    const s = String(n).padStart(ODO_N, '0');
    if (s === lastOdo) return;
    lastOdo = s;
    for (let i = 0; i < ODO_N; i++) {
        const on = SEG_ON[+s[i]];
        for (const k of 'abcdefg') {
            const el = odoSegs[i][k], want = on.indexOf(k) >= 0;
            if (el.classList.contains('on') !== want) el.classList.toggle('on', want);
        }
    }
};

// ---------- 10. MESIN: nyala = dial terang + ODO hidup + jarum menyapu; mati = layar gelap ----------
window.setEngine = function (on) {
    const v = isTrueValue(on);
    const was = state.engine;
    state.engine = v;
    elHud.classList.toggle('engine-on', v);
    if (v && !was && performance.now() > bootUntil) bootUntil = performance.now() + BOOT_MS;
    kick();
};

// ---------- Sapuan jarum (tanpa tulisan intro) ----------
window.playIntro = function () {
    if (state.engine) bootUntil = performance.now() + BOOT_MS;
    kick();
};

// ---------- Suara peringatan (Web Audio, tanpa file mp3) ----------
const SND = {
    enabled: true,
    volume: 0.3,
    seatbeltEvery: 2000,
    seatbeltMinSpeed: 1,    // m/s
    fuelBelow: 0.20,
    fuelEvery: 30000,
};
try {
    const q = new URLSearchParams(location.search);
    ['nosound', 'mute', 'silent', 'noalarm', 'noseatbelt', 'nobelt'].forEach((k) => {
        if (q.has(k) && !['0', 'false', 'no', 'off'].includes((q.get(k) || '').toLowerCase())) SND.enabled = false;
    });
    if (q.has('volume') && !isNaN(parseFloat(q.get('volume')))) SND.volume = Math.max(0, Math.min(1, parseFloat(q.get('volume'))));
} catch (e) {}
let audioCtx = null;
function getAudio() {
    if (!audioCtx) {
        const AC = window.AudioContext || window.webkitAudioContext;
        if (!AC) return null;
        audioCtx = new AC();
    }
    if (audioCtx.state === 'suspended') audioCtx.resume().catch(() => {});
    return audioCtx;
}
function tone(freq, start, dur, type, vol) {
    const a = getAudio();
    if (!a) return;
    const t0 = a.currentTime + start;
    const osc = a.createOscillator(), gain = a.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, t0);
    gain.gain.setValueAtTime(0.0001, t0);
    gain.gain.exponentialRampToValueAtTime(Math.max(0.0002, SND.volume * vol), t0 + 0.012);
    gain.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    osc.connect(gain).connect(a.destination);
    osc.start(t0);
    osc.stop(t0 + dur + 0.03);
}
window.playHudSound = function (kind) {
    if (!SND.enabled) return;
    if (kind === 'seatbelt') {
        tone(1000, 0.00, 0.14, 'triangle', 1);
        tone(1000, 0.22, 0.14, 'triangle', 1);
    } else if (kind === 'fuel') {
        tone(988, 0.00, 0.45, 'sine', 1);
        tone(1976, 0.00, 0.30, 'sine', 0.25);
        tone(740, 0.30, 0.70, 'sine', 1);
        tone(1480, 0.30, 0.45, 'sine', 0.25);
    }
};
window.setHudSound = function (on, volume) {
    SND.enabled = !!on;
    if (volume !== undefined) SND.volume = clamp01(Number(volume));
};
['pointerdown', 'keydown'].forEach((ev) => window.addEventListener(ev, getAudio, { once: true }));

let lastSeatBeep = -Infinity, lastFuelChime = -Infinity;
setInterval(() => {
    if (!SND.enabled) return;
    const now = performance.now();
    const seatWarn = state.engine && !state.belted && state.mps > SND.seatbeltMinSpeed;
    if (!seatWarn) lastSeatBeep = -Infinity;
    else if (now - lastSeatBeep >= SND.seatbeltEvery) { lastSeatBeep = now; window.playHudSound('seatbelt'); }

    const fuelWarn = state.engine && state.fuel < SND.fuelBelow;
    if (!fuelWarn) lastFuelChime = -Infinity;
    else if (now - lastFuelChime >= SND.fuelEvery) { lastFuelChime = now; window.playHudSound('fuel'); }
}, 250);

window.setSeatbeltSoundEnabled = (on) => window.setHudSound(!!on);
window.setSeatbeltVolume = (v) => { const n = parseFloat(v); if (!isNaN(n)) window.setHudSound(SND.enabled, n); };

// ---------- Pesan NUI: window.postMessage({ action: 'setEngine', state: true }) ----------
window.addEventListener('message', function (event) {
    const d = event.data;
    if (!d || typeof d !== 'object') return;
    if (d.type === 'setDoors' || d.action === 'setDoors' || d.type === 'lock') {
        window.updateLockStatus(d.status !== undefined ? d.status : d.state);
    }
    if (d.type === 'playIntro' || d.action === 'playIntro') window.playIntro();
    if (!d.action) return;
    try {
        switch (d.action) {
            case 'setEngine': window.setEngine(d.state); break;
            case 'setSpeed': window.setSpeed(Number(d.speed) || 0); break;
            case 'setRPM': window.setRPM(Number(d.rpm) || 0); break;
            case 'setFuel': window.setFuel(Number(d.fuel) || 0); break;
            case 'setHealth': window.setHealth(Number(d.health) || 0); break;
            case 'setGear': window.setGear(d.gear !== undefined ? d.gear : 'N'); break;
            case 'setHeadlights':
            case 'setLights': window.setHeadlights(Number(d.state !== undefined ? d.state : d.lights) || 0); break;
            case 'setSeatbelts': window.setSeatbelts(!!d.state); break;
            case 'setOdometer': window.setOdometer(Number(d.distance) || 0); break;
            case 'toggleVbox': window.toggleVbox(); break;
            case 'setVbox': window.setVbox(d.state !== undefined ? !!d.state : true); break;
            case 'resetVbox': window.resetVbox(); break;
            case 'muteSeatbelt': window.setSeatbeltSoundEnabled(false); break;
            case 'unmuteSeatbelt': window.setSeatbeltSoundEnabled(true); break;
            case 'setSeatbeltSound': window.setSeatbeltSoundEnabled(d.enabled !== undefined ? !!d.enabled : !d.disabled); break;
            case 'setVolume': window.setSeatbeltVolume(d.volume !== undefined ? d.volume : d.value); break;
        }
    } catch (e) { /* abaikan pesan rusak */ }
});

// ---------- Nilai awal ----------
window.setSpeed(0);
window.setRPM(0);
window.setFuel(100);
window.setHealth(1000);
window.setGear('N');
window.setHeadlights(0);
window.setSeatbelts(false);
window.setEngine(false);
window.updateLockStatus(false);
window.setOdometer(0);
window.playIntro();

// ---------- VBOX Performance Box Touch ----------
// Otomatis mengukur: 0-60 mph, 0-100 km/h, 0-100 mph, 100-200 km/h, 1/8 mil, 1/4 mil (+ kecepatan trap).
// Mulai saat mobil berhenti total lalu jalan; ikut berjalan walau panel ditutup.
// API: toggleVbox() | setVbox(bool) | resetVbox()  (juga lewat postMessage & tombol V)
const VB_STILL = 0.28, VB_MID_A = 100 / 3.6, VB_MID_B = 200 / 3.6;
const VB_TESTS = [
    { id: 'z60',   n: '0-60',    u: 'MPH',  type: 'v', v: 60 / MPS_TO_MPH },
    { id: 'z100k', n: '0-100',   u: 'KM/H', type: 'v', v: 100 / 3.6 },
    { id: 'z100m', n: '0-100',   u: 'MPH',  type: 'v', v: 100 / MPS_TO_MPH },
    { id: 'mid',   n: '100-200', u: 'KM/H', type: 'mid' },
    { id: 'e',     n: '1/8',     u: 'MIL',  type: 'd', d: 201.168 },
    { id: 'q',     n: '1/4',     u: 'MIL',  type: 'd', d: 402.336 },
];
const VB = { open: false, unit: 'mph', phase: 'wait', t0: 0, dist: 0, lastT: 0, lastV: 0, stillSince: 0, g: 0, res: {}, midT: null, lastMark: 0, frozen: 0 };
(function () {
    $('vbox').innerHTML = `
    <div class="vb-top"><span class="vb-logo">VBOX</span><span class="vb-sub">PERFORMANCE BOX TOUCH</span><span class="vb-gps"><i></i>GPS 100Hz</span></div>
    <div class="vb-screen">
      <div class="vb-status" id="vb-status">STOP TO ARM</div>
      <div class="vb-main">
        <div class="vb-speed" id="vb-speed" title="Klik untuk ganti MPH / KM/H"><b id="vb-spd">0</b><em id="vb-unit">MPH</em></div>
        <div class="vb-time"><b id="vb-t">0.00</b><em>S</em></div>
      </div>
      <div class="vb-g">G <b id="vb-g">+0.00</b></div>
      <div class="vb-rows">${VB_TESTS.map((t) => `<div class="vb-row" id="vbr-${t.id}"><span class="n">${t.n}<small>${t.u}</small></span><b class="t" id="vbt-${t.id}">--.--</b><span class="x" id="vbx-${t.id}"></span></div>`).join('')}</div>
    </div>
    <div class="vb-btns"><button type="button" id="vb-reset">RESET</button><button type="button" id="vb-close">CLOSE</button></div>`;
})();
const vbSpeedK = () => (VB.unit === 'mph' ? MPS_TO_MPH : 3.6);
function vbRender(now) {
    const run = VB.phase === 'run', el = run ? (now - VB.t0) / 1000 : VB.frozen;
    setText($('vb-spd'), Math.round(state.mps * vbSpeedK()));
    setText($('vb-unit'), VB.unit === 'mph' ? 'MPH' : 'KM/H');
    setText($('vb-t'), el.toFixed(2));
    setText($('vb-g'), (VB.g >= 0 ? '+' : '-') + Math.abs(VB.g).toFixed(2));
    const st = $('vb-status'), label = run ? 'RUNNING' : VB.phase === 'ready' ? 'READY - GO!' : 'STOP TO ARM';
    setText(st, label); if (st.className !== 'vb-status ' + VB.phase) st.className = 'vb-status ' + VB.phase;
    for (const t of VB_TESTS) {
        const r = VB.res[t.id], row = $('vbr-' + t.id);
        const live = run && !r && (t.type !== 'mid' || VB.midT !== null);
        setText($('vbt-' + t.id), r ? r.t.toFixed(2) : live ? (t.type === 'mid' ? el - VB.midT : el).toFixed(2) : '--.--');
        setText($('vbx-' + t.id), r && r.v ? Math.round(r.v * vbSpeedK()) + (VB.unit === 'mph' ? ' mph' : ' km/h') : '');
        const cls = 'vb-row' + (r ? ' done' : live ? ' live' : '');
        if (row.className !== cls) row.className = cls;
    }
}
function vbTick() {
    const now = performance.now(), v = state.mps;
    if (!VB.lastT) { VB.lastT = now; VB.lastV = v; return; }
    const dt = (now - VB.lastT) / 1000, lv = VB.lastV;
    if (dt <= 0) return;
    VB.lastT = now; VB.lastV = v;
    if (dt > 0.3) return;                                   // tab sempat tertahan: lewati sampel ini
    VB.g += ((v - lv) / dt / 9.81 - VB.g) * 0.15;
    const still = v <= VB_STILL, frac = (target) => clamp01((v - target) / ((v - lv) || 1));
    if (VB.phase === 'run') {
        const prev = VB.dist, el = (now - VB.t0) / 1000;
        VB.dist += ((v + lv) / 2) * dt;
        const mark = (id, t, extra) => { VB.res[id] = Object.assign({ t }, extra); };
        for (const t of VB_TESTS) {
            if (VB.res[t.id] || t.type === 'mid') continue;
            if (t.type === 'v' && v >= t.v) { const tt = el - dt * frac(t.v); mark(t.id, tt); VB.lastMark = Math.max(VB.lastMark, tt); }
            if (t.type === 'd' && VB.dist >= t.d) { const tt = el - dt * clamp01((VB.dist - t.d) / ((VB.dist - prev) || 1)); mark(t.id, tt, { v }); VB.lastMark = Math.max(VB.lastMark, tt); }
        }
        if (!VB.res.mid) {                                  // 100 -> 200 km/h (gagal kalau kecepatan turun di bawah 100 sebelum 200)
            if (lv < VB_MID_A && v >= VB_MID_A && VB.midT === null) VB.midT = el - dt * frac(VB_MID_A);
            if (VB.midT !== null && v < VB_MID_A) VB.midT = null;
            if (VB.midT !== null && v >= VB_MID_B) { const tt = el - dt * frac(VB_MID_B); mark('mid', tt - VB.midT); VB.lastMark = Math.max(VB.lastMark, tt); }
        }
        if (still) {
            if (!VB.stillSince) VB.stillSince = now;
            else if (now - VB.stillSince > 1000) { VB.frozen = VB.lastMark || (VB.stillSince - VB.t0) / 1000; VB.phase = 'ready'; }
        } else VB.stillSince = 0;
    } else if (still) {
        if (!VB.stillSince) VB.stillSince = now;
        else if (now - VB.stillSince > 400) VB.phase = 'ready';
    } else {
        VB.stillSince = 0;
        if (VB.phase === 'ready') {                         // LAUNCH: waktu 0 diinterpolasi tepat saat lepas dari diam
            VB.phase = 'run'; VB.res = {}; VB.midT = null; VB.lastMark = 0; VB.frozen = 0; VB.dist = 0;
            VB.t0 = now - dt * 1000 * frac(VB_STILL);
        }
    }
    if (VB.open) vbRender(now);
}
setInterval(vbTick, 40);
window.setVbox = function (on) {
    VB.open = !!on;
    $('vbox').classList.toggle('open', VB.open);
    $('vbox-btn').classList.toggle('on', VB.open);
    if (VB.open) vbRender(performance.now());
};
window.toggleVbox = () => window.setVbox(!VB.open);
window.resetVbox = function () {
    VB.res = {}; VB.midT = null; VB.lastMark = 0; VB.frozen = 0; VB.stillSince = 0;
    if (VB.phase === 'run') VB.phase = 'wait';
    if (VB.open) vbRender(performance.now());
};
$('vbox-btn').addEventListener('click', window.toggleVbox);
$('vb-close').addEventListener('click', () => window.setVbox(false));
$('vb-reset').addEventListener('click', window.resetVbox);
$('vb-speed').addEventListener('click', () => { VB.unit = VB.unit === 'mph' ? 'kmh' : 'mph'; vbRender(performance.now()); });
window.addEventListener('keydown', (e) => { if (e.key === 'v' || e.key === 'V') window.toggleVbox(); });
try { if (new URLSearchParams(location.search).has('nobutton')) document.body.classList.add('no-btn'); } catch (e) {}

// ---------- Demo (otomatis di preview Netlify atau dengan ?demo) ----------
const params = new URLSearchParams(location.search);
const isPreview = params.has('demo') || (/netlify\.app$/.test(location.hostname) && !params.has('nodemo'));

if (isPreview) {
    document.body.classList.add('preview');
    const btnE = $('dev-engine'), btnL = $('dev-lights');
    const LIGHT_NAMES = ['OFF', 'LOW', 'HIGH'];
    const toggleEngine = () => { setEngine(!state.engine); };
    const cycleLights = () => { setHeadlights((state.lights + 1) % 3); };
    btnE.addEventListener('click', toggleEngine);
    btnL.addEventListener('click', cycleLights);
    window.addEventListener('keydown', (e) => {
        if (e.key === 'e' || e.key === 'E') toggleEngine();
        if (e.key === 'l' || e.key === 'L') cycleLights();
    });

    const GEAR_TOP = [0, 28, 48, 72, 98, 128, 165];
    let mps = 0, gear = 1, throttle = true, odo = 18452.3, health = 1000, fuel = 86;
    setInterval(() => {
        btnE.textContent = 'Mesin: ' + (state.engine ? 'ON' : 'OFF');
        btnE.classList.toggle('on', state.engine);
        btnL.textContent = 'Lampu: ' + LIGHT_NAMES[state.lights];
        btnL.classList.toggle('on', state.lights > 0);

        if (!state.engine || performance.now() < bootUntil) {   // mesin mati / masih menyapu: mobil diam
            mps = 0; gear = 1; throttle = true;
            setSpeed(0); setRPM(0); setGear('N');
            return;
        }
        const mph = mps * MPS_TO_MPH;
        if (throttle) mps += 0.38 / gear; else mps -= 0.55;
        if (mph > 150) throttle = false;
        if (mps <= 0) { mps = 0; throttle = true; }
        while (gear < 6 && mph > GEAR_TOP[gear]) gear++;
        while (gear > 1 && mph < GEAR_TOP[gear - 1] - 6) gear--;
        const lo = GEAR_TOP[gear - 1], hi = GEAR_TOP[gear];
        const rpm = 0.11 + clamp01((mph - lo) / (hi - lo)) * (throttle ? 0.89 : 0.6);
        health = Math.max(180, health - 0.9); if (health <= 180) health = 1000;
        fuel = fuel <= 4 ? 86 : fuel - 0.02;
        odo += (mph * 0.05) / 3600;
        setSpeed(mps); setRPM(rpm); setGear(gear); setHealth(health); setFuel(fuel); setOdometer(odo);
    }, 50);
    setTimeout(() => { setSeatbelts(true); updateLockStatus(false); }, 1500);
}
