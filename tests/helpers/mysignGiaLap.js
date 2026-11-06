/**
 * tests/helpers/mysignGiaLap.js
 * MySign GIẢ cho test: một server HTTP nói đúng các API Viettel mà services/mysign/client.js gọi
 * (login, certificates/info, signHash bất đồng bộ, requests/status), ký bằng một khóa RSA và chứng thư tự cấp
 * dựng tại chỗ. Không gọi mạng ra ngoài.
 *
 * Điều khiển từ test:
 *   gl.cheDo = 'cho' | 'dong_y' | 'tu_choi' | 'het_han'   — người ký trên điện thoại sẽ làm gì (mặc định: chờ)
 *   gl.yeuCau                                             — các yêu cầu ký đã nhận (để soi hash, tên tài liệu…)
 *   gl.nguoiDung                                          — các user_id MySign hợp lệ
 */

const http = require('http');
const crypto = require('crypto');
const D = require('../../services/mysign/der');

const tenX = (cn, o) => D.seq(D.set(D.seq(D.oid('2.5.4.3'), D.utf8(cn))), D.set(D.seq(D.oid('2.5.4.10'), D.utf8(o))));
const CA_GIA_LAP = tenX('Viettel-CA Gia Lap', 'Viettel Gia Lap');

/**
 * Chứng thư X.509 v3 (DER) như Viettel-CA cấp: chứng thư người ký (keyUsage digitalSignature + nonRepudiation) do một CA ký;
 * `ca` vắng mặt thì tạo chính chứng thư CA (tự ký, basicConstraints CA).
 */
function taoChungThu({ ten, khoa, ca }) {
  const algSha256Rsa = D.seq(D.oid('1.2.840.113549.1.1.11'), D.nul());
  const spki = khoa.publicKey.export({ type: 'spki', format: 'der' });
  const laCa = !ca;
  const ext = (oid, giaTri) => D.seq(D.oid(oid), D.tlv(0x01, Buffer.from([0xff])), D.octet(giaTri));
  const tbs = D.seq(
    D.nguCanh(0, D.int(2)),
    D.int(crypto.randomBytes(8)),
    algSha256Rsa,
    CA_GIA_LAP,
    D.seq(D.utcTime(new Date(Date.now() - 86400000)), D.utcTime(new Date(Date.now() + 365 * 86400000))),
    laCa ? CA_GIA_LAP : tenX(ten, 'Vien Te bao goc'),
    spki,
    D.tlv(0xa3, [
      D.seq(
        ext('2.5.29.19', laCa ? D.seq(D.tlv(0x01, Buffer.from([0xff]))) : D.seq()),
        // keyUsage: CA → keyCertSign + cRLSign; người ký → digitalSignature + nonRepudiation
        ext('2.5.29.15', laCa ? Buffer.from([0x03, 0x02, 0x01, 0x06]) : Buffer.from([0x03, 0x02, 0x06, 0xc0]))
      ),
    ])
  );
  const chuKy = crypto.sign('sha256', tbs, (ca || { khoa }).khoa.privateKey);
  return D.seq(tbs, algSha256Rsa, D.tlv(0x03, [Buffer.from([0]), chuKy]));
}

/** CA giả + chứng thư người ký do CA đó cấp. Trả {khoa, chungThu, ca:{khoa, chungThu}}. */
function taoNguoiKy(ten) {
  const caKhoa = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const ca = { khoa: caKhoa, chungThu: taoChungThu({ khoa: caKhoa }) };
  const khoa = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  return { khoa, chungThu: taoChungThu({ ten, khoa, ca }), ca };
}

/** Ký mã băm SHA-256 như dịch vụ CSC: RSA PKCS#1 v1.5 trên DigestInfo(sha256, hash). */
function kyMaBam(khoaRieng, hash) {
  const digestInfo = D.seq(D.seq(D.oid('2.16.840.1.101.3.4.2.1'), D.nul()), D.octet(hash));
  return crypto.privateEncrypt({ key: khoaRieng, padding: crypto.constants.RSA_PKCS1_PADDING }, digestInfo);
}

async function dungMySignGiaLap() {
  const { khoa, chungThu, ca } = taoNguoiKy('PHAM VIEN TRUONG');
  const gl = {
    khoa,
    chungThu,
    ca,
    cheDo: 'cho',
    yeuCau: [],
    nguoiDung: new Set(['VT_MYSIGN_001']),
    client: { client_id: 'eoffice_test', client_secret: 'bi-mat-test', profile_id: 'adss:ras:profile:001' },
    goi: [], // nhật ký đường dẫn đã gọi
  };
  const token = new Map(); // access_token → user_id
  const giaoDich = new Map(); // transactionId → {user, hashes}

  const traLoi = (res, s, body) => {
    res.writeHead(s, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
  };

  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      gl.goi.push(req.url);
      let b = {};
      try { b = JSON.parse(raw || '{}'); } catch (_) { return traLoi(res, 400, { error: 'invalid_request' }); }
      const user = token.get(String(req.headers.authorization || '').replace(/^Bearer /, ''));
      const dungClient = b.client_id === gl.client.client_id && b.client_secret === gl.client.client_secret;

      if (req.url === '/vtss/service/ras/v1/login') {
        if (!dungClient) return traLoi(res, 401, { error: '59033', error_description: 'Failed to process request - user ID or password is invalid' });
        if (!gl.nguoiDung.has(b.user_id)) return traLoi(res, 400, { error: '58008', error_description: 'Failed to process request - User ID does not exist' });
        const t = crypto.randomBytes(16).toString('hex');
        token.set(t, b.user_id);
        return traLoi(res, 200, { access_token: t, token_type: 'Bearer', expires_in: '3600' });
      }
      if (!user) return traLoi(res, 401, { error: 'invalid_token' });

      if (req.url === '/vtss/service/certificates/info') {
        return traLoi(res, 200, [
          {
            key: { status: 'ENABLED', algo: ['1.2.840.113549.1.1.1'], len: 2048 },
            cert: {
              status: 'valid',
              certificates: [chungThu.toString('base64'), ca.chungThu.toString('base64')], // người ký, rồi CA
              subjectDN: 'CN=PHAM VIEN TRUONG, O=Vien Te bao goc',
              issuerDN: 'CN=Viettel-CA Gia Lap',
              SerialNumber: '5AAC41CD8FA22B953640',
              validFrom: '20260101000000Z',
              validTo: '20271231000000Z',
            },
            authMode: 'implicit',
            credential_id: 'CRED_' + user,
            phone_number: '0912345678',
          },
        ]);
      }
      if (req.url === '/vtss/service/signHash') {
        if (!dungClient || b.credentialID !== 'CRED_' + user) return traLoi(res, 400, { error: 'invalid_request', error_description: 'Invalid parameter credentialID' });
        if (!Array.isArray(b.hash) || b.hash.length !== b.numSignatures || b.documents.length !== b.numSignatures) {
          return traLoi(res, 400, { error: 'invalid_request', error_description: 'Invalid parameter numSignatures' });
        }
        gl.yeuCau.push(b);
        const id = crypto.randomUUID();
        giaoDich.set(id, { user, hashes: b.hash });
        return traLoi(res, 200, { transactionId: id });
      }
      if (req.url === '/vtss/service/requests/status') {
        const g = giaoDich.get(b.transactionId);
        if (!g || g.user !== user) return traLoi(res, 400, { error: '58011', error_description: 'Transaction ID does not exist' });
        const ma = { cho: '4000', dong_y: '1', tu_choi: '4002', het_han: '4001' }[gl.cheDo];
        if (ma !== '1') return traLoi(res, 200, { status: ma });
        const sigs = g.hashes.map((h) => kyMaBam(gl.khoa.privateKey, Buffer.from(h, 'base64')).toString('base64'));
        return traLoi(res, 200, { status: '1', signatures: sigs });
      }
      return traLoi(res, 404, { error: 'not_found' });
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  gl.base = 'http://127.0.0.1:' + server.address().port;
  gl.cauHinh = { baseUrl: gl.base, clientId: gl.client.client_id, clientSecret: gl.client.client_secret, profileId: gl.client.profile_id };
  gl.dung = () => new Promise((r) => server.close(r));
  return gl;
}

module.exports = { dungMySignGiaLap, taoChungThu, taoNguoiKy, kyMaBam };
