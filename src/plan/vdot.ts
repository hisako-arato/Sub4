// Jack Daniels の VDOT（ランニング・フォーミュラ）による走力指標と練習ペース。
// VO2(v)  = -4.60 + 0.182258 v + 0.000104 v^2        （v: m/分）
// %max(t) = 0.8 + 0.1894393 e^(-0.012778 t) + 0.2989558 e^(-0.1932605 t)   （t: 分）
// VDOT = VO2(v) / %max(t)

const vo2 = (v: number) => -4.6 + 0.182258 * v + 0.000104 * v * v;
const pctMax = (tMin: number) => 0.8 + 0.1894393 * Math.exp(-0.012778 * tMin) + 0.2989558 * Math.exp(-0.1932605 * tMin);

/** 距離(km)とタイム(秒)から VDOT */
export function vdotFromRace(km: number, seconds: number): number {
  const tMin = seconds / 60;
  const v = (km * 1000) / tMin;
  return vo2(v) / pctMax(tMin);
}

/** VO2 が target になる速度(m/分) */
function velocityForVo2(target: number): number {
  const a = 0.000104, b = 0.182258, c = -4.6 - target;
  return (-b + Math.sqrt(b * b - 4 * a * c)) / (2 * a);
}

/** VDOT から距離のタイム(秒)を予測（二分探索） */
export function predictTime(vdot: number, km: number): number {
  let lo = 60, hi = 60 * 60 * 10;
  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2;
    if (vdotFromRace(km, mid) > vdot) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

/** VDOT と強度（VO2max に対する割合）から 1km あたりの秒数 */
export function paceAt(vdot: number, intensity: number): number {
  return 60000 / velocityForVo2(vdot * intensity);
}

/** 秒/km → "5:41" */
export function fmtPace(secPerKm: number): string {
  const s = Math.round(secPerKm);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/** 秒 → "4:24:44" */
export function fmtTime(sec: number): string {
  const s = Math.round(sec);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60;
  return h ? `${h}:${String(m).padStart(2, "0")}:${String(r).padStart(2, "0")}` : `${m}:${String(r).padStart(2, "0")}`;
}

// Daniels の強度の目安
export const INTENSITY = {
  easySlow: 0.62,
  easyFast: 0.7,
  threshold: 0.88,
  interval: 0.975,
} as const;
