/**
 * src/routes/doi.js
 * Route: POST /api/doi/fetch
 *
 * Frontend gọi khi người dùng nhập DOI vào form thêm công bố.
 * Trả về metadata đã enrich sẵn để điền vào form.
 */

import { Router } from 'express';
import { fetchAndEnrichDOI } from '../services/doiService.js';

export const doiRouter = Router();

// POST /api/doi/fetch
// Body: { doi: "10.xxxx/xxxxx", orcid_raw_data?: { title, journalTitle, pubYear, putCode, url, … } }
// Response: luôn có metadata tối thiểu; xem import_status / data_source
doiRouter.post('/fetch', async (req, res, next) => {
  try {
    const { doi, orcid_raw_data } = req.body;
    if (!doi || typeof doi !== 'string') {
      return res.status(400).json({ ok: false, error: 'Thiếu trường doi' });
    }

    const data = await fetchAndEnrichDOI(doi.trim(), {
      orcid_raw_data: orcid_raw_data && typeof orcid_raw_data === 'object' ? orcid_raw_data : null,
    });
    res.json({ ok: true, data });
  } catch (err) {
    const msg = err.message || '';
    if (msg.includes('DOI không hợp lệ')) {
      return res.status(400).json({ ok: false, error: err.message });
    }
    next(err);
  }
});
