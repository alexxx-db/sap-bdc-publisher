import { Router } from 'express';
import {
  listSharesRaw,
  describeShare,
  showAllInShare,
  showGrantsOnShare,
  describeTableColumns,
  getTablePrimaryKey,
} from '../dbx.js';
import { getRequestUser } from '../auth.js';

const router = Router();
const BDC_RECIPIENT_RE = /^bdc-connect-/i;
function norm(s) { return String(s || '').toLowerCase(); }

router.get('/', async (req, res, next) => {
  try {
    const warehouseId = String(req.query.warehouseId || '');
    if (!warehouseId) { const e = new Error('warehouseId query param is required'); e.status = 400; throw e; }
    const user = getRequestUser(req);
    const userEmail = norm(user.userName || user.email);

    const shares = await listSharesRaw(req, warehouseId);
    if (!shares.length) {
      return res.json({ shares: [], note: 'No shares visible to you.' });
    }

    // BDC-publish state is read straight from SHOW GRANTS ON SHARE: any
    // bdc-connect-* recipient with SELECT is treated as published. This is
    // the same signal /api/diag uses and the same condition the unpublish
    // flow REVOKEs, so the dropdown can never disagree with UC reality.
    // Trade-off: a manually-added GRANT (no real BDC publish) would also
    // show up here; that's a fair fallback compared to needing the
    // activity log fully wired before delete works.
    const results = await Promise.all(shares.map(async (s) => {
      const isCreator = norm(s.created_by) === userEmail;
      let isOwner = isCreator;
      let owner = s.created_by;
      const userGrants = [];
      const publishedRecipients = [];
      try {
        const grants = await showGrantsOnShare(req, warehouseId, s.name);
        for (const g of grants) {
          // SHOW GRANTS ON SHARE columns: `recipient`, `privilege` (not principal/action_type).
          const principal = g.recipient || g.Recipient || g.principal || g.Principal;
          const priv = String(g.privilege || g.action_type || g.ActionType || '').toUpperCase();
          if (!principal || !priv) continue;
          if (norm(principal) === userEmail) userGrants.push(priv);
          if (priv === 'SELECT' && BDC_RECIPIENT_RE.test(principal)) {
            publishedRecipients.push(principal);
          }
        }
      } catch { /* best effort */ }
      try {
        const desc = await describeShare(req, warehouseId, s.name);
        const d0 = desc[0] || {};
        if (d0.owner) { owner = d0.owner; isOwner = norm(d0.owner) === userEmail; }
      } catch { /* best effort */ }
      const accessible = isOwner || userGrants.length > 0;
      return {
        share: { ...s, owner },
        accessible, isOwner, userGrants,
        publishedToBdc: publishedRecipients.length > 0,
        publishedRecipients,
      };
    }));

    const accessible = results.filter((r) => r.accessible);
    res.json({
      shares: accessible.map((r) => ({
        name: r.share.name, owner: r.share.owner,
        createdBy: r.share.created_by, createdAt: r.share.created_at,
        comment: r.share.comment, isOwner: r.isOwner, userGrants: r.userGrants,
        publishedToBdc: r.publishedToBdc,
        publishedRecipients: r.publishedRecipients,
      })),
      counts: { total: shares.length, accessible: accessible.length },
    });
  } catch (err) { next(err); }
});

router.get('/:name', async (req, res, next) => {
  try {
    const warehouseId = String(req.query.warehouseId || '');
    if (!warehouseId) { const e = new Error('warehouseId query param is required'); e.status = 400; throw e; }
    const name = req.params.name;
    const user = getRequestUser(req);
    const userEmail = norm(user.userName || user.email);

    const [descRows, objRows, grants] = await Promise.all([
      describeShare(req, warehouseId, name),
      showAllInShare(req, warehouseId, name),
      showGrantsOnShare(req, warehouseId, name).catch(() => []),
    ]);

    const d0 = descRows[0] || {};
    const owner = d0.owner || d0.created_by || null;
    const objects = objRows.map((r) => ({
      name: r.name || r.shared_object || '',
      dataObjectType: String(r.type || '').toUpperCase(),
      sharedAs: r.shared_object || null,
      addedAt: r.added_at || null,
      addedBy: r.added_by || null,
      comment: r.comment || null,
    })).filter((o) => o.name || o.dataObjectType);

    const userGrants = [];
    for (const g of grants) {
      const principal = g.recipient || g.Recipient || g.principal || g.Principal;
      const priv = String(g.privilege || g.action_type || g.ActionType || '').toUpperCase();
      if (principal && norm(principal) === userEmail && priv) userGrants.push(priv);
    }

    res.json({
      name, owner, comment: d0.comment || null,
      isOwner: owner && norm(owner) === userEmail,
      userGrants, objects,
    });
  } catch (err) { next(err); }
});

router.get('/:name/tables', async (req, res, next) => {
  try {
    const warehouseId = String(req.query.warehouseId || '');
    if (!warehouseId) { const e = new Error('warehouseId query param is required'); e.status = 400; throw e; }
    const name = req.params.name;
    const objRows = await showAllInShare(req, warehouseId, name);
    const tables = objRows.filter((r) => String(r.type || '').toUpperCase() === 'TABLE');

    const results = await Promise.all(tables.map(async (r) => {
      const sharedAs = r.name || r.shared_object || '';
      const fullName = r.shared_object || r.name || '';
      const [columns, primaryKey] = await Promise.all([
        describeTableColumns(req, warehouseId, fullName),
        getTablePrimaryKey(req, warehouseId, fullName),
      ]);
      return { sharedAs, fullName, columns, primaryKey, hasPrimaryKey: primaryKey.length > 0 };
    }));

    res.json({ tables: results, count: results.length });
  } catch (err) { next(err); }
});

export default router;
