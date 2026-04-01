import { useState, useEffect, useRef } from "react";

// ─── Design tokens — tiệp với hệ thống gốc ──────────────────────────────
const T = {
  grad: "linear-gradient(135deg, #667eea 0%, #764ba2 100%)",
  gradH: "linear-gradient(135deg, #764ba2 0%, #667eea 100%)",
  primary: "#667eea",
  secondary: "#764ba2",
  bg: "linear-gradient(135deg, #667eea 0%, #764ba2 100%)",
  white: "#ffffff",
  surface: "#f8f9ff",
  border: "#e8ecff",
  text: "#333333",
  muted: "#666666",
  light: "#999999",
  success: "#4caf88",
  warning: "#f5a623",
  danger: "#e05c6a",
  shadow: "0 10px 30px rgba(102,126,234,0.15)",
  shadowLg: "0 20px 50px rgba(102,126,234,0.25)",
  radius: "15px",
  radiusSm: "10px",
  radiusXs: "8px",
  font: "'Segoe UI', Tahoma, Geneva, Verdana, sans-serif",
};

// ─── Helpers ─────────────────────────────────────────────────────────────
const HOURS = Array.from({ length: 24 }, (_, i) => i);
const PAD = (n) => String(n).padStart(2, "0");
/** Nhãn cột lịch (chỉ đầu giờ) */
const fmt = (h) => `${PAD(h)}:00`;
/** Giờ đặt lịch có thể có :30 (lưu dạng số thực, bước 0.5) */
const fmtTime = (t) => {
  const totalMins = Math.round(Number(t) * 60);
  const hh = Math.floor(totalMins / 60) % 24;
  const mm = totalMins % 60;
  return `${PAD(hh)}:${PAD(mm)}`;
};
const fmtDur = (d) => {
  const totalMins = Math.round(Number(d) * 60);
  const hh = Math.floor(totalMins / 60);
  const mm = totalMins % 60;
  if (mm === 0) return `${hh} giờ`;
  if (hh === 0) return `${mm} phút`;
  return `${hh} giờ ${mm} phút`;
};
const isHalfHourMark = (t) => Number.isFinite(t) && Math.abs(Math.round(t * 2) - t * 2) < 1e-5;
const hourToClock = (t) => {
  const totalMins = Math.round(Number(t) * 60);
  const hh = Math.floor(totalMins / 60) % 24;
  const mm = totalMins % 60;
  return `${PAD(hh)}:${PAD(mm)}:00`;
};
const today = () => new Date().toISOString().split("T")[0];
const uid = () => Math.random().toString(36).slice(2, 10);

// ─── Seed data ────────────────────────────────────────────────────────────
const SEED_MACHINES = [
  { id: "m1", name: "SEM-7000", type: "Kính hiển vi điện tử quét", location: "Lab A-01", color: "#667eea", availFrom: 8, availTo: 20, maxHours: 4, desc: "Scanning Electron Microscope, phóng đại 7000x" },
  { id: "m2", name: "XRD-Pro", type: "Máy nhiễu xạ tia X", location: "Lab A-02", color: "#764ba2", availFrom: 7, availTo: 22, maxHours: 6, desc: "Bột X-Ray Diffractometer nguồn Cu Kα" },
  { id: "m3", name: "FTIR-4000", type: "Máy quang phổ hồng ngoại", location: "Lab B-01", color: "#4caf88", availFrom: 8, availTo: 18, maxHours: 3, desc: "Fourier-transform infrared spectrometer" },
  { id: "m4", name: "TEM-HiRes", type: "Kính hiển vi điện tử truyền qua", location: "Lab B-02", color: "#f5a623", availFrom: 9, availTo: 17, maxHours: 2, desc: "High-resolution Transmission Electron Microscope" },
  { id: "m5", name: "Rheometer-AR", type: "Máy đo lưu biến", location: "Lab C-01", color: "#e05c6a", availFrom: 8, availTo: 20, maxHours: 5, desc: "Advanced Rheometer đo độ nhớt vật liệu" },
];

const SEED_USERS = [
  { id: "u_admin", name: "Admin CRD", email: "admin@crd.edu.vn", role: "admin", password: "admin123", avatar: "A" },
  { id: "u1", name: "Nguyễn Minh Khoa", email: "khoa@crd.edu.vn", role: "user", password: "123456", avatar: "K" },
  { id: "u2", name: "Trần Thị Lan", email: "lan@crd.edu.vn", role: "user", password: "123456", avatar: "L" },
  { id: "u3", name: "Lê Văn Hùng", email: "hung@crd.edu.vn", role: "user", password: "123456", avatar: "H" },
];

const SEED_BOOKINGS = [
  { id: "b1", machineId: "m1", userId: "u1", date: today(), startH: 9, endH: 11, purpose: "Phân tích vật liệu nano", status: "confirmed" },
  { id: "b2", machineId: "m2", userId: "u2", date: today(), startH: 13, endH: 16, purpose: "Phân tích cấu trúc tinh thể", status: "confirmed" },
  { id: "b3", machineId: "m3", userId: "u3", date: today(), startH: 10, endH: 12, purpose: "Nghiên cứu thành phần polymer", status: "confirmed" },
];

const SEED_CHATS = [
  { id: "c1", fromId: "u1", toId: "u2", bookingId: "b2", msg: "Chào bạn, mình cần dùng XRD lúc 14h–15h, bạn có thể dời sang 15h không?", ts: Date.now() - 3600000, read: false },
  { id: "c2", fromId: "u2", toId: "u1", bookingId: "b2", msg: "Mình xem lại lịch nhé, có thể được. Để mình kiểm tra thêm.", ts: Date.now() - 1800000, read: true },
];

// ─── Global styles ────────────────────────────────────────────────────────
const injectStyles = () => {
  if (document.getElementById("crd-styles")) return;
  const s = document.createElement("style");
  s.id = "crd-styles";
  s.textContent = `
    @import url('https://fonts.googleapis.com/css2?family=Segoe+UI:wght@400;600;700&display=swap');
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; background: linear-gradient(135deg,#667eea,#764ba2); min-height: 100vh; }
    input, textarea, select, button { font-family: inherit; }
    ::-webkit-scrollbar { width: 5px; height: 5px; }
    ::-webkit-scrollbar-track { background: #f0f0f8; }
    ::-webkit-scrollbar-thumb { background: #c5c9f0; border-radius: 3px; }
    @keyframes fadeUp { from { opacity:0; transform:translateY(12px); } to { opacity:1; transform:translateY(0); } }
    @keyframes shimmer { 0%,100%{opacity:1} 50%{opacity:.6} }
    .fade-up { animation: fadeUp .3s ease both; }
    .card-hover { transition: transform .25s, box-shadow .25s; }
    .card-hover:hover { transform: translateY(-5px); box-shadow: 0 20px 50px rgba(102,126,234,.3) !important; }
  `;
  document.head.appendChild(s);
};

// ─── Reusable Components ──────────────────────────────────────────────────
const Card = ({ children, style = {}, className = "" }) => (
  <div className={`card-hover ${className}`} style={{ background: T.white, borderRadius: T.radius, boxShadow: T.shadow, padding: 24, ...style }}>
    {children}
  </div>
);

const Btn = ({ children, onClick, variant = "primary", size = "md", disabled, fullWidth, style = {} }) => {
  const base = {
    border: "none", cursor: disabled ? "not-allowed" : "pointer", fontFamily: T.font,
    fontWeight: 600, borderRadius: T.radiusXs, transition: "all .25s",
    opacity: disabled ? .55 : 1, display: "inline-flex", alignItems: "center",
    justifyContent: "center", gap: 6, width: fullWidth ? "100%" : undefined,
  };
  const sizes = {
    sm: { padding: "6px 14px", fontSize: 12 },
    md: { padding: "10px 20px", fontSize: 14 },
    lg: { padding: "13px 28px", fontSize: 15 },
  };
  const variants = {
    primary: { background: T.grad, color: "#fff", boxShadow: "0 4px 14px rgba(102,126,234,.35)" },
    ghost: { background: "transparent", color: T.muted, border: `1px solid ${T.border}` },
    danger: { background: T.danger, color: "#fff" },
    success: { background: T.success, color: "#fff" },
    outline: { background: "transparent", color: T.primary, border: `1px solid ${T.primary}` },
    white: { background: T.white, color: T.primary, boxShadow: T.shadow },
  };
  return (
    <button disabled={disabled} onClick={onClick}
      style={{ ...base, ...sizes[size], ...variants[variant], ...style }}
      onMouseEnter={e => { if (!disabled && variant === "primary") e.currentTarget.style.transform = "scale(1.04)"; }}
      onMouseLeave={e => { e.currentTarget.style.transform = "scale(1)"; }}>
      {children}
    </button>
  );
};

const Field = ({ label, value, onChange, type = "text", placeholder, required, min, max, note }) => (
  <div style={{ marginBottom: 16 }}>
    {label && (
      <label style={{ display: "block", fontSize: 12, color: T.muted, marginBottom: 5, fontWeight: 600, textTransform: "uppercase", letterSpacing: .7 }}>
        {label}{required && <span style={{ color: T.danger }}> *</span>}
      </label>
    )}
    <input type={type} value={value} onChange={e => onChange(e.target.value)} placeholder={placeholder} min={min} max={max}
      style={{ width: "100%", border: `1.5px solid ${T.border}`, borderRadius: T.radiusXs, padding: "9px 13px", fontSize: 14, color: T.text, outline: "none", background: T.surface, transition: "border-color .2s" }}
      onFocus={e => e.target.style.borderColor = T.primary}
      onBlur={e => e.target.style.borderColor = T.border} />
    {note && <div style={{ fontSize: 11, color: T.light, marginTop: 4 }}>{note}</div>}
  </div>
);

const SelectField = ({ label, value, onChange, options, required }) => (
  <div style={{ marginBottom: 16 }}>
    {label && (
      <label style={{ display: "block", fontSize: 12, color: T.muted, marginBottom: 5, fontWeight: 600, textTransform: "uppercase", letterSpacing: .7 }}>
        {label}{required && <span style={{ color: T.danger }}> *</span>}
      </label>
    )}
    <select value={value === undefined || value === null ? "" : String(value)} onChange={e => onChange(e.target.value)}
      style={{ width: "100%", border: `1.5px solid ${T.border}`, borderRadius: T.radiusXs, padding: "9px 13px", fontSize: 14, color: T.text, outline: "none", background: T.surface, appearance: "none", backgroundImage: "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='8'%3E%3Cpath d='M0 0l6 8 6-8z' fill='%23999'/%3E%3C/svg%3E\")", backgroundRepeat: "no-repeat", backgroundPosition: "right 12px center" }}>
      {options.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
    </select>
  </div>
);

const Modal = ({ title, subtitle, onClose, children, width = 500 }) => (
  <div style={{ position: "fixed", inset: 0, background: "rgba(102,126,234,.25)", backdropFilter: "blur(4px)", zIndex: 1000, display: "flex", alignItems: "center", justifyContent: "center", padding: 16 }}
    onClick={e => e.target === e.currentTarget && onClose()}>
    <div className="fade-up" style={{ background: T.white, borderRadius: T.radius, width, maxWidth: "100%", maxHeight: "90vh", overflow: "auto", boxShadow: T.shadowLg }}>
      <div style={{ background: T.grad, padding: "20px 24px", borderRadius: `${T.radius} ${T.radius} 0 0` }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <div>
            <div style={{ fontWeight: 700, fontSize: 17, color: "#fff" }}>{title}</div>
            {subtitle && <div style={{ fontSize: 12, color: "rgba(255,255,255,.75)", marginTop: 2 }}>{subtitle}</div>}
          </div>
          <button onClick={onClose} style={{ background: "rgba(255,255,255,.2)", border: "none", color: "#fff", cursor: "pointer", width: 28, height: 28, borderRadius: "50%", fontSize: 16, display: "flex", alignItems: "center", justifyContent: "center" }}>×</button>
        </div>
      </div>
      <div style={{ padding: 24 }}>{children}</div>
    </div>
  </div>
);

const Badge = ({ children, color, bg }) => (
  <span style={{ background: bg || color + "18", color, border: `1px solid ${color}33`, borderRadius: 20, padding: "3px 10px", fontSize: 11, fontWeight: 600 }}>{children}</span>
);

const Avatar = ({ char, size = 34, gradient = T.grad }) => (
  <div style={{ width: size, height: size, borderRadius: "50%", background: gradient, display: "flex", alignItems: "center", justifyContent: "center", fontSize: size * 0.38, fontWeight: 700, color: "#fff", flexShrink: 0, boxShadow: "0 3px 10px rgba(102,126,234,.3)" }}>{char}</div>
);

const SectionHeader = ({ icon, title, count, action }) => (
  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 20 }}>
    <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
      <div style={{ fontSize: 24 }}>{icon}</div>
      <div>
        <div style={{ fontWeight: 700, fontSize: 20, color: T.text }}>{title}</div>
        {count !== undefined && <div style={{ fontSize: 12, color: T.muted, marginTop: 1 }}>{count} mục</div>}
      </div>
    </div>
    {action}
  </div>
);

const Alert = ({ type = "info", children }) => {
  const colors = { info: T.primary, warning: T.warning, error: T.danger, success: T.success };
  const c = colors[type];
  return (
    <div style={{ background: c + "12", border: `1px solid ${c}33`, borderRadius: T.radiusXs, padding: "10px 14px", fontSize: 13, color: c, marginBottom: 14, display: "flex", alignItems: "flex-start", gap: 8 }}>
      <span>{type === "error" ? "⚠️" : type === "success" ? "✅" : "ℹ️"}</span>
      <span>{children}</span>
    </div>
  );
};

// ─── Timeline Grid (cột theo giờ; lịch = 1 thanh liền; click nửa ô = :00 / :30) ─
function intervalOverlaps(a0, a1, b0, b1) {
  return !(a1 <= b0 || a0 >= b1);
}

function halfSlotFree(m, date, h, half, bookings) {
  const t0 = h + half * 0.5;
  const t1 = t0 + 0.5;
  if (t0 + 1e-6 < m.availFrom || t1 > m.availTo + 1e-6) return false;
  return !bookings.some(
    b => b.machineId === m.id && b.date === date && intervalOverlaps(t0, t1, b.startH, b.endH)
  );
}

function TimelineGrid({ machines, bookings, users, date, onSlotClick }) {
  const hours = HOURS.slice(6, 23);
  const cellW = 58, cellH = 56, labelW = 170;
  const h0 = hours[0];
  const hEnd = h0 + hours.length;

  const isAvail = (m, h) => h >= m.availFrom && h < m.availTo;

  return (
    <div style={{ overflowX: "auto", overflowY: "hidden" }}>
      <div style={{ minWidth: labelW + cellW * hours.length + 2 }}>
        <div style={{ display: "flex", marginLeft: labelW, borderBottom: `2px solid ${T.border}` }}>
          {hours.map(h => (
            <div key={h} style={{ width: cellW, flexShrink: 0, fontSize: 10, color: T.light, textAlign: "center", padding: "5px 0", fontWeight: 600, borderLeft: `1px solid ${T.border}` }}>{fmt(h)}</div>
          ))}
        </div>
        {machines.map((m, mi) => {
          const rowBks = bookings.filter(b => b.machineId === m.id && b.date === date).sort((a, b) => a.startH - b.startH);
          return (
            <div key={m.id} style={{ display: "flex", borderBottom: `1px solid ${T.border}`, background: mi % 2 === 0 ? "#fff" : T.surface }}>
              <div style={{ width: labelW, flexShrink: 0, padding: "10px 14px", borderRight: `2px solid ${T.border}`, display: "flex", alignItems: "center", gap: 10 }}>
                <div style={{ width: 10, height: 10, borderRadius: "50%", background: m.color, flexShrink: 0 }} />
                <div>
                  <div style={{ fontWeight: 700, fontSize: 13, color: T.text }}>{m.name}</div>
                  <div style={{ fontSize: 10, color: T.light, lineHeight: 1.3, marginTop: 1 }}>{m.type}</div>
                </div>
              </div>
              <div style={{ position: "relative", width: cellW * hours.length, flexShrink: 0, height: cellH }}>
                {hours.map(h => {
                  const avail = isAvail(m, h);
                  return (
                    <div key={h}
                      style={{
                        position: "absolute", left: (h - h0) * cellW, top: 0,
                        width: cellW, height: cellH, borderLeft: `1px solid ${T.border}`, boxSizing: "border-box",
                        background: avail ? "linear-gradient(to right, transparent 49.6%, rgba(0,0,0,.06) 50%, transparent 50.4%)" : undefined,
                      }}>
                      {!avail && (
                        <div style={{ position: "absolute", inset: 0, background: "repeating-linear-gradient(45deg,#f0f0f8 0,#f0f0f8 3px,transparent 3px,transparent 10px)", zIndex: 0 }} />
                      )}
                      {avail && [0, 1].map(half => (
                        halfSlotFree(m, date, h, half, bookings) && onSlotClick ? (
                          <div
                            key={half}
                            role="button"
                            tabIndex={0}
                            onKeyDown={e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onSlotClick(m, h + half * 0.5); } }}
                            onClick={() => onSlotClick(m, h + half * 0.5)}
                            style={{
                              position: "absolute", left: `${half * 50}%`, width: "50%", top: 0, height: "100%", zIndex: 2,
                              cursor: "pointer", boxSizing: "border-box",
                            }}
                            title={half === 0 ? "Đặt từ :00" : "Đặt từ :30"}
                            onMouseEnter={e => { e.currentTarget.style.background = m.color + "14"; }}
                            onMouseLeave={e => { e.currentTarget.style.background = "transparent"; }}
                          />
                        ) : null
                      ))}
                    </div>
                  );
                })}
                <div style={{ position: "absolute", left: 0, top: 0, width: "100%", height: cellH, pointerEvents: "none", zIndex: 4 }}>
                  {rowBks.map(b => {
                    const visS = Math.max(b.startH, h0);
                    const visE = Math.min(b.endH, hEnd);
                    if (visE <= visS + 1e-6) return null;
                    const left = (visS - h0) * cellW;
                    const barW = Math.max((visE - visS) * cellW, 36);
                    const uname = users.find(u => u.id === b.userId)?.name || "—";
                    const timeLine = `${fmtTime(b.startH)} – ${fmtTime(b.endH)}`;
                    const roomy = barW >= 72;
                    return (
                      <div
                        key={b.id}
                        title={`${timeLine} · ${uname}`}
                        style={{
                          position: "absolute",
                          left,
                          width: barW,
                          top: 5,
                          height: cellH - 10,
                          boxSizing: "border-box",
                          borderRadius: 6,
                          background: `linear-gradient(135deg, ${m.color}22, ${m.color}44)`,
                          border: `1.5px solid ${m.color}88`,
                          padding: roomy ? "4px 10px" : "3px 6px",
                          display: "flex",
                          flexDirection: "column",
                          justifyContent: "center",
                          gap: 2,
                          overflow: "hidden",
                          minWidth: 0,
                        }}>
                        <div style={{
                          fontSize: roomy ? 11 : 9, fontWeight: 700, color: m.color, lineHeight: 1.25,
                          whiteSpace: "nowrap",
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                        }}>{timeLine}</div>
                        <div style={{
                          fontSize: roomy ? 10 : 8, color: T.muted, lineHeight: 1.25,
                          whiteSpace: "nowrap",
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                        }}>{uname}</div>
                      </div>
                    );
                  })}
                </div>
              </div>
            </div>
          );
        })}
        <div style={{ display: "flex", gap: 20, padding: "10px 0 0", fontSize: 11, color: T.muted, alignItems: "center", flexWrap: "wrap" }}>
          <span>🖱️ Mỗi ô = 1 giờ; nửa trái = :00, nửa phải = :30 — click ô trống để đặt (bước 30 phút)</span>
          <div style={{ display: "flex", alignItems: "center", gap: 5 }}>
            <div style={{ width: 18, height: 12, background: "repeating-linear-gradient(45deg,#f0f0f8 0,#f0f0f8 3px,transparent 3px,transparent 10px)", border: `1px solid ${T.border}`, borderRadius: 2 }} />
            <span>Ngoài giờ hoạt động</span>
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── Chat Panel ────────────────────────────────────────────────────────────
function ChatPanel({ chats, setChats, currentUser, users, bookings, machines, onClose }) {
  const [selId, setSelId] = useState(null);
  const [msg, setMsg] = useState("");
  const [bkRef, setBkRef] = useState("");
  const endRef = useRef();

  const others = users.filter(u => u.id !== currentUser.id && u.role !== "admin");
  const thread = chats.filter(c =>
    (c.fromId === currentUser.id && c.toId === selId) ||
    (c.fromId === selId && c.toId === currentUser.id)
  ).sort((a, b) => a.ts - b.ts);

  useEffect(() => { endRef.current?.scrollIntoView({ behavior: "smooth" }); }, [thread.length]);

  const unread = (id) => chats.filter(c => c.fromId === id && c.toId === currentUser.id && !c.read).length;

  const send = () => {
    if (!msg.trim() || !selId) return;
    setChats(p => [...p, { id: uid(), fromId: currentUser.id, toId: selId, bookingId: bkRef || null, msg: msg.trim(), ts: Date.now(), read: false }]);
    setMsg("");
  };

  return (
    <div style={{ position: "fixed", bottom: 20, right: 20, width: 390, height: 520, background: T.white, borderRadius: T.radius, boxShadow: T.shadowLg, display: "flex", flexDirection: "column", zIndex: 900, border: `1px solid ${T.border}` }}>
      <div style={{ background: T.grad, padding: "12px 16px", borderRadius: `${T.radius} ${T.radius} 0 0`, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <div style={{ color: "#fff", fontWeight: 700, fontSize: 14 }}>💬 Thương lượng lịch sử dụng</div>
        <button onClick={onClose} style={{ background: "rgba(255,255,255,.2)", border: "none", color: "#fff", cursor: "pointer", width: 26, height: 26, borderRadius: "50%", fontSize: 16, display: "flex", alignItems: "center", justifyContent: "center" }}>×</button>
      </div>
      <div style={{ display: "flex", flex: 1, overflow: "hidden" }}>
        {/* Sidebar */}
        <div style={{ width: 108, borderRight: `1px solid ${T.border}`, overflowY: "auto", background: T.surface }}>
          {others.map(u => {
            const uc = unread(u.id);
            const active = selId === u.id;
            return (
              <div key={u.id} onClick={() => setSelId(u.id)}
                style={{ padding: "10px 6px", cursor: "pointer", background: active ? T.primary + "12" : "transparent", borderLeft: `3px solid ${active ? T.primary : "transparent"}`, display: "flex", flexDirection: "column", alignItems: "center", gap: 5, transition: "all .15s" }}>
                <div style={{ position: "relative" }}>
                  <Avatar char={u.avatar} size={30} />
                  {uc > 0 && <div style={{ position: "absolute", top: -3, right: -3, width: 14, height: 14, borderRadius: "50%", background: T.danger, fontSize: 9, display: "flex", alignItems: "center", justifyContent: "center", color: "#fff", fontWeight: 700 }}>{uc}</div>}
                </div>
                <div style={{ fontSize: 9, color: active ? T.primary : T.muted, textAlign: "center", lineHeight: 1.3, fontWeight: active ? 600 : 400 }}>{u.name.split(" ").pop()}</div>
              </div>
            );
          })}
        </div>
        {/* Messages */}
        <div style={{ flex: 1, display: "flex", flexDirection: "column", overflow: "hidden" }}>
          {!selId ? (
            <div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", flexDirection: "column", gap: 8, color: T.muted }}>
              <div style={{ fontSize: 32 }}>💬</div>
              <div style={{ fontSize: 12, textAlign: "center" }}>Chọn người dùng để<br />bắt đầu thương lượng</div>
            </div>
          ) : (
            <>
              <div style={{ flex: 1, overflowY: "auto", padding: "12px 14px", display: "flex", flexDirection: "column", gap: 10 }}>
                {thread.map(c => {
                  const isMe = c.fromId === currentUser.id;
                  const bk = c.bookingId && bookings.find(b => b.id === c.bookingId);
                  const mc = bk && machines.find(m => m.id === bk.machineId);
                  return (
                    <div key={c.id} style={{ display: "flex", flexDirection: "column", alignItems: isMe ? "flex-end" : "flex-start" }}>
                      {bk && <div style={{ fontSize: 10, color: mc?.color || T.muted, marginBottom: 3, background: mc?.color + "12", padding: "2px 8px", borderRadius: 10, border: `1px solid ${mc?.color}33` }}>📅 {mc?.name} {fmtTime(bk.startH)}–{fmtTime(bk.endH)}</div>}
                      <div style={{ background: isMe ? T.grad : T.surface, borderRadius: isMe ? "14px 14px 3px 14px" : "14px 14px 14px 3px", padding: "8px 12px", maxWidth: "85%", fontSize: 12.5, color: isMe ? "#fff" : T.text, lineHeight: 1.5, boxShadow: isMe ? "0 3px 10px rgba(102,126,234,.25)" : T.shadow }}>{c.msg}</div>
                      <div style={{ fontSize: 10, color: T.light, marginTop: 3 }}>{new Date(c.ts).toLocaleTimeString("vi", { hour: "2-digit", minute: "2-digit" })}</div>
                    </div>
                  );
                })}
                <div ref={endRef} />
              </div>
              <div style={{ padding: "6px 10px", borderTop: `1px solid ${T.border}` }}>
                <select value={bkRef} onChange={e => setBkRef(e.target.value)} style={{ width: "100%", border: `1px solid ${T.border}`, borderRadius: 6, padding: "4px 8px", color: T.muted, fontSize: 10, background: T.surface, marginBottom: 6, outline: "none" }}>
                  <option value="">— Đính kèm lịch booking (tuỳ chọn) —</option>
                  {bookings.filter(b => b.userId === selId || b.userId === currentUser.id).map(b => {
                    const mc = machines.find(m => m.id === b.machineId);
                    return <option key={b.id} value={b.id}>{mc?.name} | {b.date} | {fmtTime(b.startH)}–{fmtTime(b.endH)}</option>;
                  })}
                </select>
                <div style={{ display: "flex", gap: 6 }}>
                  <input value={msg} onChange={e => setMsg(e.target.value)} onKeyDown={e => e.key === "Enter" && send()}
                    placeholder="Nhập tin nhắn..." style={{ flex: 1, border: `1.5px solid ${T.border}`, borderRadius: 8, padding: "7px 11px", fontSize: 12.5, color: T.text, outline: "none", background: T.surface }} />
                  <Btn onClick={send} size="sm" disabled={!msg.trim()}>Gửi</Btn>
                </div>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

// ─── Booking Modal ──────────────────────────────────────────────────────────
function BookingModal({ machine, startH: initH, date, onSave, onClose, bookings, currentUser }) {
  const startOpts = [];
  for (let t = machine.availFrom; t < machine.availTo; t += 0.5) {
    startOpts.push({ value: t, label: fmtTime(t) });
  }
  const endOpts = [];
  for (let t = machine.availFrom + 0.5; t <= machine.availTo; t += 0.5) {
    endOpts.push({ value: t, label: fmtTime(t) });
  }

  const [startH, setStartH] = useState(initH);
  const [endH, setEndH] = useState(() => {
    const d = Math.min(initH + 2, machine.availTo);
    return d > initH ? d : Math.min(initH + 0.5, machine.availTo);
  });
  const [purpose, setPurpose] = useState("");
  const [err, setErr] = useState("");

  useEffect(() => {
    setStartH(initH);
    const d = Math.min(initH + 2, machine.availTo);
    setEndH(d > initH ? d : Math.min(initH + 0.5, machine.availTo));
    setPurpose("");
    setErr("");
  }, [initH, machine.id, machine.availFrom, machine.availTo, date]);

  const validate = () => {
    if (!isHalfHourMark(startH) || !isHalfHourMark(endH)) return "Giờ phải theo bước 30 phút";
    if (endH <= startH) return "Giờ kết thúc phải sau giờ bắt đầu";
    if (endH - startH > machine.maxHours) return `Tối đa ${machine.maxHours} giờ/lần đặt`;
    if (startH < machine.availFrom || endH > machine.availTo) return `Máy chỉ hoạt động ${fmt(machine.availFrom)}–${fmt(machine.availTo)}`;
    const conflict = bookings.find(b => b.machineId === machine.id && b.date === date && !(endH <= b.startH || startH >= b.endH));
    if (conflict) return "Thời gian đã được đặt trước, vui lòng chọn khung giờ khác";
    if (!purpose.trim()) return "Vui lòng nhập mục đích sử dụng";
    return null;
  };

  const save = () => {
    const e = validate();
    if (e) { setErr(e); return; }
    onSave({ id: uid(), machineId: machine.id, userId: currentUser.id, date, startH, endH, purpose, status: "confirmed" });
    onClose();
  };

  const duration = endH - startH;

  const onStartChange = (v) => {
    const s = parseFloat(v);
    if (!Number.isFinite(s)) return;
    setStartH(s);
    setEndH(eh => (eh <= s ? Math.min(s + 0.5, machine.availTo) : eh));
  };
  const onEndChange = (v) => {
    const e = parseFloat(v);
    if (!Number.isFinite(e)) return;
    setEndH(e);
  };

  return (
    <Modal title="Đặt lịch sử dụng thiết bị" subtitle={`${machine.name} — ${machine.location}`} onClose={onClose}>
      <div style={{ background: machine.color + "12", border: `1.5px solid ${machine.color}33`, borderRadius: T.radiusXs, padding: "12px 16px", marginBottom: 18, display: "flex", gap: 12, alignItems: "center" }}>
        <div style={{ width: 14, height: 14, borderRadius: "50%", background: machine.color, flexShrink: 0 }} />
        <div>
          <div style={{ fontWeight: 700, color: T.text, fontSize: 14 }}>{machine.name}</div>
          <div style={{ fontSize: 12, color: T.muted }}>{machine.type} · {machine.location} · Tối đa {machine.maxHours}h/lần · Bước 30 phút</div>
        </div>
      </div>
      <div style={{ background: T.surface, borderRadius: T.radiusXs, padding: "10px 14px", marginBottom: 16, fontSize: 13, color: T.muted }}>
        📅 <strong style={{ color: T.text }}>{date}</strong>
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
        <SelectField label="Giờ bắt đầu *" value={startH} onChange={onStartChange} options={startOpts} required />
        <SelectField label="Giờ kết thúc *" value={endH} onChange={onEndChange} options={endOpts} required />
      </div>
      {duration > 0 && (
        <div style={{ textAlign: "center", marginBottom: 14, fontSize: 12, color: T.primary, background: T.primary + "10", borderRadius: T.radiusXs, padding: "6px" }}>
          ⏱ Thời lượng: <strong>{fmtDur(duration)}</strong> ({fmtTime(startH)} – {fmtTime(endH)})
        </div>
      )}
      <Field label="Mục đích sử dụng *" value={purpose} onChange={setPurpose} placeholder="VD: Phân tích cấu trúc mẫu vật liệu polymer..." required />
      {err && <Alert type="error">{err}</Alert>}
      <div style={{ display: "flex", gap: 10, justifyContent: "flex-end", marginTop: 4 }}>
        <Btn variant="ghost" onClick={onClose}>Huỷ</Btn>
        <Btn onClick={save}>✅ Xác nhận đặt lịch</Btn>
      </div>
    </Modal>
  );
}

// ─── Machine Manager ────────────────────────────────────────────────────────
function MachineManager({ machines, setMachines }) {
  const [showForm, setShowForm] = useState(false);
  const [editing, setEditing] = useState(null);
  const empty = { name: "", type: "", location: "", color: "#667eea", availFrom: 8, availTo: 20, maxHours: 4, desc: "" };
  const [form, setForm] = useState(empty);
  const set = (k, v) => setForm(f => ({ ...f, [k]: v }));

  const openAdd = () => { setForm(empty); setEditing(null); setShowForm(true); };
  const openEdit = (m) => { setForm({ ...m }); setEditing(m.id); setShowForm(true); };
  const save = () => {
    if (!form.name || !form.type) return;
    if (editing) setMachines(p => p.map(m => m.id === editing ? { ...form, id: editing } : m));
    else setMachines(p => [...p, { ...form, id: uid() }]);
    setShowForm(false);
  };
  const del = (id) => { if (confirm("Xoá thiết bị này?")) setMachines(p => p.filter(m => m.id !== id)); };

  const types = ["Kính hiển vi điện tử quét", "Máy nhiễu xạ tia X", "Máy quang phổ hồng ngoại",
    "Kính hiển vi điện tử truyền qua", "Máy đo lưu biến", "Máy sắc ký", "Thiết bị khác"];

  return (
    <div>
      <SectionHeader icon="🔬" title="Quản lý Thiết bị Phòng TN" count={machines.length} action={<Btn onClick={openAdd}>+ Thêm thiết bị</Btn>} />
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(300px,1fr))", gap: 20 }}>
        {machines.map(m => (
          <Card key={m.id} className="fade-up" style={{ borderTop: `4px solid ${m.color}`, padding: 20 }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 12 }}>
              <div>
                <div style={{ fontWeight: 700, fontSize: 17, color: T.text }}>{m.name}</div>
                <div style={{ fontSize: 12, color: T.muted, marginTop: 2 }}>{m.type}</div>
              </div>
              <div style={{ width: 12, height: 12, borderRadius: "50%", background: m.color, marginTop: 4 }} />
            </div>
            <div style={{ fontSize: 12, color: T.muted, lineHeight: 2, background: T.surface, borderRadius: T.radiusXs, padding: "10px 12px" }}>
              📍 {m.location}<br />⏰ Hoạt động: {fmt(m.availFrom)} – {fmt(m.availTo)}<br />⏱ Tối đa {m.maxHours} giờ/lần<br />
              {m.desc && <span title={m.desc}>ℹ️ {m.desc.length > 50 ? m.desc.slice(0, 50) + "..." : m.desc}</span>}
            </div>
            <div style={{ display: "flex", gap: 8, marginTop: 14 }}>
              <Btn variant="outline" size="sm" onClick={() => openEdit(m)} style={{ flex: 1 }}>✏️ Sửa</Btn>
              <Btn variant="danger" size="sm" onClick={() => del(m.id)} style={{ flex: 1 }}>🗑 Xoá</Btn>
            </div>
          </Card>
        ))}
      </div>

      {showForm && (
        <Modal title={editing ? "Chỉnh sửa thiết bị" : "Thêm thiết bị mới"} subtitle="Cấu hình thông tin thiết bị phòng thí nghiệm" onClose={() => setShowForm(false)} width={540}>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14 }}>
            <div style={{ gridColumn: "1/-1" }}><Field label="Tên thiết bị *" value={form.name} onChange={v => set("name", v)} placeholder="VD: SEM-9000" required /></div>
            <SelectField label="Loại thiết bị *" value={form.type} onChange={v => set("type", v)} options={types.map(t => ({ value: t, label: t }))} required />
            <Field label="Vị trí" value={form.location} onChange={v => set("location", v)} placeholder="Lab A-01" />
            <div style={{ gridColumn: "1/-1" }}><Field label="Mô tả" value={form.desc} onChange={v => set("desc", v)} placeholder="Chi tiết về thiết bị..." /></div>
            <div>
              <label style={{ display: "block", fontSize: 12, color: T.muted, marginBottom: 5, fontWeight: 600, textTransform: "uppercase", letterSpacing: .7 }}>Màu sắc</label>
              <input type="color" value={form.color} onChange={e => set("color", e.target.value)} style={{ width: "100%", height: 42, border: `1.5px solid ${T.border}`, borderRadius: T.radiusXs, cursor: "pointer" }} />
            </div>
            <Field label="Tối đa giờ/lần" value={form.maxHours} onChange={v => set("maxHours", +v)} type="number" min="1" max="12" note="Số giờ tối đa trong một lần đặt" />
            <SelectField label="Giờ mở cửa" value={form.availFrom} onChange={v => set("availFrom", +v)} options={HOURS.map(h => ({ value: h, label: fmt(h) }))} />
            <SelectField label="Giờ đóng cửa" value={form.availTo} onChange={v => set("availTo", +v)} options={HOURS.map(h => ({ value: h, label: fmt(h) }))} />
          </div>
          <div style={{ display: "flex", gap: 10, justifyContent: "flex-end", marginTop: 6 }}>
            <Btn variant="ghost" onClick={() => setShowForm(false)}>Huỷ</Btn>
            <Btn onClick={save}>{editing ? "Cập nhật" : "Thêm thiết bị"}</Btn>
          </div>
        </Modal>
      )}
    </div>
  );
}

// ─── Bookings Table ─────────────────────────────────────────────────────────
function BookingsTable({ bookings, setBookings, machines, users, currentUser }) {
  const [q, setQ] = useState("");
  const isAdmin = currentUser.role === "admin";

  const visible = bookings.filter(b => {
    if (!isAdmin && b.userId !== currentUser.id) return false;
    const m = machines.find(x => x.id === b.machineId);
    const u = users.find(x => x.id === b.userId);
    return !q || (m?.name + u?.name + b.date + b.purpose).toLowerCase().includes(q.toLowerCase());
  }).sort((a, b) => b.date.localeCompare(a.date) || a.startH - b.startH);

  const del = (id) => {
    const b = bookings.find(x => x.id === id);
    if (!isAdmin && b.userId !== currentUser.id) return;
    if (confirm("Huỷ lịch đặt này?")) setBookings(p => p.filter(x => x.id !== id));
  };

  return (
    <div>
      <SectionHeader icon="📋" title={isAdmin ? "Tất cả lịch đặt" : "Lịch đặt của tôi"} count={visible.length}
        action={
          <input value={q} onChange={e => setQ(e.target.value)} placeholder="🔍 Tìm kiếm lịch..."
            style={{ border: `1.5px solid ${T.border}`, borderRadius: T.radiusXs, padding: "8px 14px", fontSize: 13, width: 220, outline: "none", color: T.text, background: T.white }} />
        } />
      <Card style={{ padding: 0, overflow: "hidden" }}>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
          <thead>
            <tr style={{ background: T.surface, borderBottom: `2px solid ${T.border}` }}>
              {(isAdmin ? ["Thiết bị", "Ngày", "Thời gian", "Thời lượng", "Người đặt", "Mục đích", ""] : ["Thiết bị", "Ngày", "Thời gian", "Mục đích", "Trạng thái", ""]).map(h => (
                <th key={h} style={{ padding: "12px 16px", textAlign: "left", color: T.muted, fontSize: 11, fontWeight: 700, textTransform: "uppercase", letterSpacing: .8 }}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {visible.map((b, i) => {
              const m = machines.find(x => x.id === b.machineId);
              const u = users.find(x => x.id === b.userId);
              const canEdit = isAdmin || b.userId === currentUser.id;
              const isPast = new Date(`${b.date}T${hourToClock(b.endH)}`) < new Date();
              return (
                <tr key={b.id} style={{ borderBottom: `1px solid ${T.border}`, background: i % 2 ? T.surface : T.white, transition: "background .15s" }}
                  onMouseEnter={e => e.currentTarget.style.background = T.primary + "08"}
                  onMouseLeave={e => e.currentTarget.style.background = i % 2 ? T.surface : T.white}>
                  <td style={{ padding: "12px 16px" }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                      <div style={{ width: 10, height: 10, borderRadius: "50%", background: m?.color, flexShrink: 0 }} />
                      <span style={{ fontWeight: 700, color: m?.color }}>{m?.name}</span>
                    </div>
                    <div style={{ fontSize: 10, color: T.light, marginTop: 2, marginLeft: 18 }}>{m?.location}</div>
                  </td>
                  <td style={{ padding: "12px 16px", color: T.muted, fontVariantNumeric: "tabular-nums" }}>{b.date}</td>
                  <td style={{ padding: "12px 16px", fontWeight: 600, color: T.text }}>{fmtTime(b.startH)} – {fmtTime(b.endH)}</td>
                  {isAdmin && <td style={{ padding: "12px 16px" }}><Badge color={T.primary}>{fmtDur(b.endH - b.startH)}</Badge></td>}
                  {isAdmin && (
                    <td style={{ padding: "12px 16px" }}>
                      <div style={{ display: "flex", alignItems: "center", gap: 7 }}>
                        <Avatar char={u?.avatar} size={24} />
                        <span style={{ fontSize: 12 }}>{u?.name}</span>
                      </div>
                    </td>
                  )}
                  <td style={{ padding: "12px 16px", color: T.muted, maxWidth: 180, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={b.purpose}>{b.purpose}</td>
                  {!isAdmin && (
                    <td style={{ padding: "12px 16px" }}>
                      <Badge color={isPast ? T.light : T.success}>{isPast ? "Đã qua" : "Đã đặt"}</Badge>
                    </td>
                  )}
                  <td style={{ padding: "12px 16px" }}>
                    {canEdit && <Btn variant="ghost" size="sm" onClick={() => del(b.id)} style={{ color: T.danger, borderColor: T.danger + "44" }}>Huỷ</Btn>}
                  </td>
                </tr>
              );
            })}
            {visible.length === 0 && (
              <tr><td colSpan={7} style={{ padding: "40px 0", textAlign: "center", color: T.muted }}>
                <div style={{ fontSize: 36, marginBottom: 10 }}>📅</div>
                <div>Không có lịch đặt nào</div>
              </td></tr>
            )}
          </tbody>
        </table>
      </Card>
    </div>
  );
}

// ─── User Manager ───────────────────────────────────────────────────────────
function UserManager({ users, setUsers, bookings }) {
  return (
    <div>
      <SectionHeader icon="👥" title="Quản lý Người dùng" count={users.length} />
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(260px,1fr))", gap: 18 }}>
        {users.map(u => {
          const myBk = bookings.filter(b => b.userId === u.id).length;
          const isAdmin = u.role === "admin";
          return (
            <Card key={u.id} className="fade-up" style={{ padding: 20 }}>
              <div style={{ display: "flex", gap: 14, alignItems: "center", marginBottom: 14 }}>
                <Avatar char={u.avatar} size={44} gradient={isAdmin ? "linear-gradient(135deg,#764ba2,#667eea)" : T.grad} />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontWeight: 700, fontSize: 15, color: T.text }}>{u.name}</div>
                  <div style={{ fontSize: 11, color: T.muted, overflow: "hidden", textOverflow: "ellipsis", marginTop: 2 }}>{u.email}</div>
                  <div style={{ marginTop: 6 }}><Badge color={isAdmin ? T.secondary : T.primary}>{isAdmin ? "🔑 Admin" : "🔬 Researcher"}</Badge></div>
                </div>
              </div>
              <div style={{ background: T.surface, borderRadius: T.radiusXs, padding: "8px 12px", fontSize: 12, color: T.muted }}>
                📋 Đã đặt <strong style={{ color: T.primary }}>{myBk}</strong> lịch
              </div>
              {!isAdmin && (
                <Btn variant="ghost" size="sm" fullWidth style={{ marginTop: 12, color: T.danger, borderColor: T.danger + "44" }}
                  onClick={() => { if (confirm(`Xoá tài khoản ${u.name}?`)) setUsers(p => p.filter(x => x.id !== u.id)); }}>
                  🗑 Xoá tài khoản
                </Btn>
              )}
            </Card>
          );
        })}
      </div>
    </div>
  );
}

// ─── Auth Screen ────────────────────────────────────────────────────────────
function AuthScreen({ users, setUsers, onLogin }) {
  const [tab, setTab] = useState("login");
  const [email, setEmail] = useState("");
  const [pass, setPass] = useState("");
  const [name, setName] = useState("");
  const [err, setErr] = useState("");
  const [loading, setLoading] = useState(false);

  const login = () => {
    setLoading(true);
    setTimeout(() => {
      const u = users.find(x => x.email === email && x.password === pass);
      if (!u) { setErr("Email hoặc mật khẩu không đúng"); setLoading(false); return; }
      onLogin(u);
    }, 400);
  };

  const register = () => {
    if (!name || !email || !pass) { setErr("Vui lòng điền đầy đủ thông tin"); return; }
    if (users.find(u => u.email === email)) { setErr("Email này đã được đăng ký"); return; }
    if (pass.length < 6) { setErr("Mật khẩu tối thiểu 6 ký tự"); return; }
    const nu = { id: uid(), name, email, role: "user", password: pass, avatar: name.trim().split(" ").pop()[0].toUpperCase() };
    setUsers(p => [...p, nu]);
    onLogin(nu);
  };

  return (
    <div style={{ minHeight: "100vh", background: T.bg, display: "flex", alignItems: "center", justifyContent: "center", padding: 20 }}>
      <div style={{ width: "100%", maxWidth: 460 }}>
        {/* Logo */}
        <div style={{ background: T.white, borderRadius: T.radius, padding: "32px 40px 24px", marginBottom: 20, textAlign: "center", boxShadow: T.shadowLg }}>
          <div style={{ fontSize: 48, marginBottom: 8 }}>🔬</div>
          <h1 style={{ fontSize: 24, fontWeight: 700, color: T.primary, marginBottom: 4 }}>CRD Lab Booking</h1>
          <p style={{ fontSize: 13, color: T.muted }}>Hệ thống đăng ký sử dụng thiết bị</p>
          <p style={{ fontSize: 12, color: T.light, marginTop: 4 }}>Viện Tế bào gốc – Trường ĐHKHTN, ĐHQG TP.HCM</p>
        </div>

        <div className="fade-up" style={{ background: T.white, borderRadius: T.radius, padding: "28px 32px", boxShadow: T.shadowLg }}>
          {/* Tabs */}
          <div style={{ display: "flex", background: T.surface, borderRadius: T.radiusXs, padding: 4, marginBottom: 24, gap: 4 }}>
            {[["login", "Đăng nhập"], ["register", "Đăng ký"]].map(([t, l]) => (
              <button key={t} onClick={() => { setTab(t); setErr(""); }}
                style={{ flex: 1, border: "none", borderRadius: 6, padding: "9px", fontFamily: T.font, fontWeight: 600, fontSize: 13.5, cursor: "pointer", transition: "all .2s", background: tab === t ? T.grad : "transparent", color: tab === t ? "#fff" : T.muted, boxShadow: tab === t ? "0 3px 10px rgba(102,126,234,.3)" : "none" }}>{l}</button>
            ))}
          </div>

          {tab === "register" && <Field label="Họ và tên *" value={name} onChange={setName} placeholder="Nguyễn Văn A" required />}
          <Field label="Email *" value={email} onChange={setEmail} type="email" placeholder="example@crd.edu.vn" required />
          <Field label="Mật khẩu *" value={pass} onChange={v => setPass(v)} type="password" placeholder="••••••••" required />

          {err && <Alert type="error">{err}</Alert>}

          <Btn fullWidth onClick={tab === "login" ? login : register} style={{ marginTop: 4, fontSize: 15 }}>
            {loading ? "⏳ Đang xử lý..." : tab === "login" ? "Đăng nhập →" : "Tạo tài khoản →"}
          </Btn>

          {tab === "login" && (
            <div style={{ marginTop: 18, background: T.surface, borderRadius: T.radiusXs, padding: "12px 14px", fontSize: 12, color: T.muted, lineHeight: 1.9, border: `1px solid ${T.border}` }}>
              <strong>Demo accounts:</strong><br />
              🔑 Admin: <code>admin@crd.edu.vn</code> / admin123<br />
              🔬 User: <code>khoa@crd.edu.vn</code> / 123456
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ─── Main App ───────────────────────────────────────────────────────────────
export default function App() {
  useEffect(() => { injectStyles(); }, []);

  const [machines, setMachines] = useState(SEED_MACHINES);
  const [users, setUsers] = useState(SEED_USERS);
  const [bookings, setBookings] = useState(SEED_BOOKINGS);
  const [chats, setChats] = useState(SEED_CHATS);
  const [currentUser, setCurrentUser] = useState(null);
  const [tab, setTab] = useState("calendar");
  const [date, setDate] = useState(today());
  const [bookingModal, setBookingModal] = useState(null);
  const [showChat, setShowChat] = useState(false);

  if (!currentUser) return <AuthScreen users={users} setUsers={setUsers} onLogin={u => { setCurrentUser(u); setTab("calendar"); }} />;

  const isAdmin = currentUser.role === "admin";
  const myUnread = chats.filter(c => c.toId === currentUser.id && !c.read).length;
  const todayBk = bookings.filter(b => b.date === today()).length;
  const myBk = bookings.filter(b => b.userId === currentUser.id).length;

  const TABS = [
    { id: "calendar", label: "📅 Lịch trực quan" },
    { id: "bookings", label: "📋 Danh sách lịch" },
    ...(isAdmin ? [{ id: "machines", label: "🔬 Thiết bị" }, { id: "users", label: "👥 Người dùng" }] : []),
  ];

  return (
    <div style={{ minHeight: "100vh", background: T.bg, padding: "20px" }}>
      <div style={{ maxWidth: 1400, margin: "0 auto" }}>

        {/* Header */}
        <div style={{ background: T.white, borderRadius: T.radius, padding: "24px 32px", marginBottom: 24, boxShadow: T.shadowLg, display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 16 }}>
          <div>
            <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 4 }}>
              <div style={{ fontSize: 32 }}>🔬</div>
              <div>
                <h1 style={{ fontSize: 22, fontWeight: 700, color: T.primary }}>Hệ thống Đặt lịch Thiết bị – CRD</h1>
                <p style={{ fontSize: 12, color: T.muted }}>Viện Tế bào gốc · Trường ĐHKHTN, ĐHQG TP.HCM</p>
              </div>
            </div>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
            {!isAdmin && (
              <button onClick={() => setShowChat(v => !v)}
                style={{ position: "relative", background: showChat ? T.primary + "12" : T.surface, border: `1.5px solid ${showChat ? T.primary : T.border}`, borderRadius: T.radiusXs, padding: "8px 16px", cursor: "pointer", color: showChat ? T.primary : T.muted, fontFamily: T.font, fontWeight: 600, fontSize: 13, transition: "all .2s" }}>
                💬 Thương lượng
                {myUnread > 0 && <span style={{ position: "absolute", top: -6, right: -6, width: 18, height: 18, borderRadius: "50%", background: T.danger, fontSize: 10, display: "flex", alignItems: "center", justifyContent: "center", color: "#fff", fontWeight: 700 }}>{myUnread}</span>}
              </button>
            )}
            <div style={{ display: "flex", alignItems: "center", gap: 10, background: T.surface, borderRadius: 30, padding: "6px 14px 6px 6px", border: `1px solid ${T.border}` }}>
              <Avatar char={currentUser.avatar} size={32} gradient={isAdmin ? "linear-gradient(135deg,#764ba2,#667eea)" : T.grad} />
              <div>
                <div style={{ fontSize: 13, fontWeight: 700, color: T.text, lineHeight: 1.2 }}>{currentUser.name}</div>
                <div style={{ fontSize: 10, color: T.muted }}>{isAdmin ? "Administrator" : "Researcher"}</div>
              </div>
            </div>
            <Btn variant="ghost" size="sm" onClick={() => setCurrentUser(null)}>Đăng xuất</Btn>
          </div>
        </div>

        {/* Stats */}
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(160px,1fr))", gap: 16, marginBottom: 24 }}>
          {[
            { icon: "📋", n: bookings.length, label: "Tổng lịch đặt" },
            { icon: "📅", n: todayBk, label: "Đặt hôm nay" },
            { icon: "🔬", n: machines.length, label: "Thiết bị" },
            { icon: "👤", n: isAdmin ? users.length : myBk, label: isAdmin ? "Người dùng" : "Lịch của tôi" },
          ].map(s => (
            <div key={s.label} style={{ background: T.white, borderRadius: T.radius, padding: 20, textAlign: "center", boxShadow: T.shadow, transition: "transform .25s" }}
              onMouseEnter={e => e.currentTarget.style.transform = "translateY(-4px)"}
              onMouseLeave={e => e.currentTarget.style.transform = "translateY(0)"}>
              <div style={{ fontSize: 32, marginBottom: 6 }}>{s.icon}</div>
              <div style={{ fontSize: 28, fontWeight: 700, color: T.primary }}>{s.n}</div>
              <div style={{ fontSize: 12, color: T.muted, marginTop: 3 }}>{s.label}</div>
            </div>
          ))}
        </div>

        {/* Tabs */}
        <div style={{ background: T.white, borderRadius: T.radius, boxShadow: T.shadow, marginBottom: 20, overflow: "hidden" }}>
          <div style={{ display: "flex", borderBottom: `1px solid ${T.border}`, overflowX: "auto" }}>
            {TABS.map(t => (
              <button key={t.id} onClick={() => setTab(t.id)}
                style={{ border: "none", background: "none", padding: "16px 22px", fontFamily: T.font, fontWeight: 600, fontSize: 13.5, cursor: "pointer", color: tab === t.id ? T.primary : T.muted, borderBottom: `3px solid ${tab === t.id ? T.primary : "transparent"}`, transition: "all .2s", whiteSpace: "nowrap" }}>
                {t.label}
              </button>
            ))}
          </div>

          <div style={{ padding: 24 }}>
            {/* Calendar */}
            {tab === "calendar" && (
              <div className="fade-up">
                <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 20, flexWrap: "wrap" }}>
                  <div style={{ fontWeight: 700, fontSize: 17, color: T.text }}>Lịch sử dụng thiết bị</div>
                  <div style={{ display: "flex", alignItems: "center", gap: 6, background: T.surface, border: `1.5px solid ${T.border}`, borderRadius: T.radiusXs, padding: "6px 12px" }}>
                    <button onClick={() => { const d = new Date(date); d.setDate(d.getDate() - 1); setDate(d.toISOString().split("T")[0]); }}
                      style={{ background: "none", border: "none", color: T.muted, cursor: "pointer", fontSize: 18, lineHeight: 1, padding: "0 2px" }}>‹</button>
                    <input type="date" value={date} onChange={e => setDate(e.target.value)}
                      style={{ background: "none", border: "none", color: T.text, fontSize: 13.5, fontFamily: T.font, fontWeight: 600, cursor: "pointer", outline: "none" }} />
                    <button onClick={() => { const d = new Date(date); d.setDate(d.getDate() + 1); setDate(d.toISOString().split("T")[0]); }}
                      style={{ background: "none", border: "none", color: T.muted, cursor: "pointer", fontSize: 18, lineHeight: 1, padding: "0 2px" }}>›</button>
                  </div>
                  <Btn variant="outline" size="sm" onClick={() => setDate(today())}>Hôm nay</Btn>
                  {!isAdmin && <Btn size="sm" onClick={() => setBookingModal({ machine: machines[0], startH: 9 })}>+ Đặt lịch mới</Btn>}
                </div>

                {/* Machine legend */}
                <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginBottom: 16 }}>
                  {machines.map(m => (
                    <div key={m.id} style={{ display: "flex", alignItems: "center", gap: 6, background: m.color + "12", border: `1px solid ${m.color}44`, borderRadius: 20, padding: "4px 12px", fontSize: 12, color: m.color, fontWeight: 600 }}>
                      <div style={{ width: 8, height: 8, borderRadius: "50%", background: m.color }} />
                      {m.name}
                    </div>
                  ))}
                </div>

                <TimelineGrid machines={machines} bookings={bookings} users={users} date={date}
                  onSlotClick={(m, h) => setBookingModal({ machine: m, startH: h })} />
              </div>
            )}

            {tab === "bookings" && (
              <div className="fade-up">
                <BookingsTable bookings={bookings} setBookings={setBookings} machines={machines} users={users} currentUser={currentUser} />
              </div>
            )}

            {tab === "machines" && isAdmin && (
              <div className="fade-up">
                <MachineManager machines={machines} setMachines={setMachines} />
              </div>
            )}

            {tab === "users" && isAdmin && (
              <div className="fade-up">
                <UserManager users={users} setUsers={setUsers} bookings={bookings} />
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Booking modal */}
      {bookingModal && (
        <BookingModal key={`${bookingModal.machine.id}-${bookingModal.startH}`} machine={bookingModal.machine} startH={bookingModal.startH} date={date}
          bookings={bookings} currentUser={currentUser}
          onSave={b => setBookings(p => [...p, b])}
          onClose={() => setBookingModal(null)} />
      )}

      {/* Chat */}
      {showChat && !isAdmin && (
        <ChatPanel chats={chats} setChats={setChats} currentUser={currentUser}
          users={users} bookings={bookings} machines={machines} onClose={() => setShowChat(false)} />
      )}
    </div>
  );
}
