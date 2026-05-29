# Databricks → SAP BDC Publisher

[![Databricks](https://img.shields.io/badge/Databricks-Marketplace_App-FF3621?style=for-the-badge&logo=databricks)](https://databricks.com)
[![Unity Catalog](https://img.shields.io/badge/Unity_Catalog-Enabled-00A1C9?style=for-the-badge)](https://docs.databricks.com/en/data-governance/unity-catalog/index.html)
[![Delta Sharing](https://img.shields.io/badge/Delta_Sharing-Required-1B3139?style=for-the-badge)](https://docs.databricks.com/en/delta-sharing/index.html)

A Databricks App that automates publishing a Unity Catalog share to SAP
Business Data Cloud (BDC Connect) in a few clicks. Replaces the manual
notebook workflow (run SQL, call BDC SDK, publish data product) with a
guided UI.

---

## Installation

Two paths. Pick **Option A** unless you need to customize the source
before deploy.

### Option A: Databricks Marketplace (recommended)

1. In Databricks: open **Marketplace**, search **SAP BDC Publisher**,
   click **Get access**. You're redirected to the Apps view with a
   two-step install dialog.
2. **Review authorization and metadata.** Inspect the User
   Authorization scope (`sql`) and the App Authorization scope.
   Optionally set the App name, Description, and Serverless usage
   policy.
3. Click **Install**. The platform deploys the app; no bundle, no
   deploy job, no SP grant step required.
4. Open the App URL from the app's page. The Activity tab launches a
   one-time setup sub-wizard on first visit (provisions or adopts a
   Delta table for the audit log; ~10 seconds). Start publishing.

### Option B: Asset Bundle from GitHub (manual)

For development, self-hosting, or customizing the app source before
deploy.

1. **Get the code into your workspace**, either:
   - In Databricks Workspace, **Clone from GitHub**, paste this repo URL.
   - Or open the repo in the Marketplace and click **Get access** to
     have it cloned into a workspace folder.

2. **Open the Asset Bundle Editor** on the cloned `databricks.yml` (the
   UI auto-detects it).

3. **Click "Deploy"** in the Asset Bundle Editor. This uploads the app
   source under `./apps/bdc-sharing/` to a bundle-managed workspace
   path, registers the `bdc-sharing` Databricks App resource (with the
   `sql` user-API scope already set), and stages the
   `bdc_publish` / `bdc_unpublish` notebooks the app calls at runtime.
   The app itself comes up **UNAVAILABLE** at this point: bundle
   deploy does not bind source to the app on its own.

4. **Run the `deploy_bdc_sharing_app` job** from the Asset Bundle UI's
   Runs tab (🚀 icon, click **Run** next to the job). This starts the
   app compute and calls the Apps Deploy API with the source path the
   bundle uploaded. Takes ~2 minutes. The app reaches **RUNNING**.

5. **(If the in-app warehouse dropdown is empty)** the warehouse list
   is OBO-driven, so the picker reflects warehouses **you** have
   `CAN_USE` on. If you have access but the SP needs to start the
   warehouse on your behalf and lacks `CAN_USE`, an admin can grant it:

   ```bash
   databricks warehouses set-permissions <warehouse-id> \
     --json '{"access_control_list":[
       {"service_principal_name":"<bdc-sharing-sp-client-id>","permission_level":"CAN_USE"}
     ]}'
   ```

6. **Open the App URL** from the App's page and start publishing. The
   Activity tab launches a one-time setup sub-wizard on first visit
   (provisions or adopts a Delta table for the audit log; takes ~10
   seconds).

---

## Prerequisites

| What | Why |
|---|---|
| Unity Catalog + Delta Sharing enabled in the workspace | shares and recipients live here |
| At least one serverless SQL warehouse | used for `SHOW`/`DESCRIBE` queries and for the activity-log writes |
| An SAP BDC Connect recipient with `authentication_type = OIDC_FEDERATION` (typically named `bdc-connect-*`) | the BDC publish target. **`TOKEN`-type recipients require additional workspace setup — see the FAQ entry "Publish fails with 'Secret does not exist with scope: sap-bdc-connect-sdk'"** |
| Workspace user with `ALTER` (or ownership) on the share you want to publish | UC enforces this when the app issues `GRANT SELECT ON SHARE` |

The app **does not** require workspace-admin rights for either the user or
the service principal. UC privileges on the share + `CAN_USE` on a
warehouse are sufficient.

---

## How it works

The app uses **two identities** simultaneously — a hybrid auth model:

| Identity | Used for |
|---|---|
| **End user** (via OBO token, scope `sql`) | Listing SQL warehouses (the picker reflects warehouses *you* have `CAN_USE` on), all UC reads (`SHOW SHARES`, `SHOW RECIPIENTS`, `DESCRIBE …`, `SHOW GRANTS …`), and the privilege mutations on the share itself: `GRANT SELECT ON SHARE` (publish) and `REVOKE SELECT ON SHARE` (delete). UC enforces ownership / `ALTER` on the share against the user's identity. |
| **App service principal** | Starting and polling SQL warehouses on your behalf, submitting the BDC publish/delete Jobs, polling job status. The Job itself runs as the SP, **no `run_as`, no workspace-admin requirement**. The Job only calls the BDC SDK, which doesn't depend on user identity. |

Audit trail stays coherent: `system.access.audit` shows GRANT/REVOKE
attributed to the user; the BDC SDK calls are attributed to the SP. The
app's own activity log (configured via the in-app wizard) merges both
views.

```
┌────────────────┐       ┌─────────────────────┐       ┌──────────────────┐
│   Browser      │◄─────►│ Express (Node)      │──────►│ Databricks APIs  │
│ static HTML +  │ HTTPS │  - /api/me          │ SP +  │  - SQL Warehouses│
│ vanilla JS     │       │  - /api/warehouses  │ OBO   │  - Statement Exec│
└────────────────┘       │  - /api/shares      │       │  - Jobs 2.2      │
                         │  - /api/recipients  │       │  - SCIM /Me      │
                         │  - /api/grants      │       │  - Apps (self)   │
                         │  - /api/publish     │       │  - Workspace I/O │
                         │  - /api/unpublish   │       └────────┬─────────┘
                         │  - /api/activity    │                │
                         │  - /api/setup       │                ▼
                         └─────────────────────┘      ┌────────────────────┐
                                                      │ Serverless Jobs    │
                                                      │ run as the SP      │
                                                      │  - bdc_publish.py  │
                                                      │  - bdc_unpublish.py│
                                                      └────────────────────┘
```

---

## Repo layout

```
.
├── apps/bdc-sharing/        # Databricks App source — everything that ships to Marketplace
│   ├── README.md            # In-app docs, served at /README.md (identical to this file)
│   ├── app.yaml             # Apps runtime config (command, env, scopes)
│   ├── manifest.yaml        # Databricks Marketplace listing manifest
│   ├── package.json         # Express + npm
│   ├── notebooks/
│   │   ├── bdc_publish.py   # Submitted by the publish route at runtime
│   │   └── bdc_unpublish.py # Submitted by the delete route at runtime
│   ├── public/              # Static UI (index.html, activity.html, docs.html, faq.html)
│   └── server/              # Express backend (routes/, dbx.js, auth.js, notebooks.js, …)
├── notebooks/
│   └── deploy_app.py        # DAB-only deploy job: binds app source + grants SP read (Option B)
├── databricks.yml           # Asset Bundle definition (Option B install path)
├── requirements.txt         # Python deps for the runtime notebooks
└── env.example              # App env vars (mirrored from app.yaml for local reference)
```

---

## Contributing

PRs welcome. By submitting a contribution you accept the terms in
[`CONTRIBUTING.md`](./CONTRIBUTING.md).

For local iteration, the fastest loop is:

```bash
databricks bundle validate           # Confirm bundle is well-formed
databricks bundle deploy             # Deploy app + notebooks to your workspace
databricks bundle run demo_workflow  # Sanity-check the SDK installs
```

CI on every PR runs the same against the workspace configured via the
`DATABRICKS_HOST` repo variable (see `.github/workflows/databricks-ci.yml`)
and tears down the deployment afterward.

---

## Third-Party Package Licenses

&copy; 2026 Databricks, Inc. All rights reserved. Source provided subject to
the [Databricks License](./LICENSE.md). Third-party libraries:

| Package | License | Copyright |
|---|---|---|
| [express](https://github.com/expressjs/express) | MIT | © OpenJS Foundation and Express contributors |
| [sap-bdc-connect-sdk](https://pypi.org/project/sap-bdc-connect-sdk/) | SAP Developer License | © SAP SE |
| [databricks-sdk](https://pypi.org/project/databricks-sdk/) | Apache-2.0 | © Databricks, Inc. |
