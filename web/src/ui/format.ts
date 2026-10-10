/** Number formatting for the interface. Direction is always shown with a sign or arrow, never colour alone. */
const TINY = 0.00005;
const MINUS = "−";   // a true minus sign, same width as a plus

export const F = {
  sMoney: (v: number) => { const r = Math.round(v); return (r > 0 ? "+" : r < 0 ? MINUS : "") + "$" + Math.abs(r).toLocaleString("en-US"); },
  money: (v: number) => (v < 0 ? MINUS : "") + "$" + Math.abs(Math.round(v)).toLocaleString("en-US"),
  price: (v: number) => "$" + v.toFixed(2),
  pct: (v: number, digits = 0) => (v * 100).toFixed(digits).replace(/\.0$/, "").replace(/^-/, MINUS) + "%",
  sPct: (v: number, digits = 1) => {
    const t = Math.abs(v * 100).toFixed(digits).replace(/\.0$/, "");
    return (Number(t) === 0 ? "" : v > 0 ? "+" : MINUS) + t + "%";
  },
  count: (v: number) => Math.round(v).toLocaleString("en-US"),
  sCount: (v: number) => { const r = Math.round(v); return (r > 0 ? "+" : r < 0 ? MINUS : "") + Math.abs(r).toLocaleString("en-US"); },
  arrow: (v: number, eps = TINY) => (v > eps ? "▲" : v < -eps ? "▼" : "◆"),
  tone: (v: number, eps = TINY) => (v > eps ? "#1F7A4D" : v < -eps ? "#B4361F" : "#16181D"),
};
