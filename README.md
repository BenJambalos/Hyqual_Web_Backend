# HyQual

HyQual is organized into two top-level projects:

- `frontend/` — React and Vite web application.
- `backend/` — Express API, MySQL schema, authentication, mobile/device
  endpoints, admin bootstrap, and the Firebase data importer.

Each directory has its own `package.json` and `package-lock.json`. Install
each project's dependencies from the repository root:

```sh
npm ci --prefix frontend
npm ci --prefix backend
```

## Local development

1. Copy `backend/.env.example` to `backend/.env` and fill in your MySQL
   connection settings.
2. Start the API in one terminal:

   ```sh
   npm start --prefix backend
   ```

3. Start the website in another terminal:

   ```sh
   npm run dev --prefix frontend
   ```

The Vite dev server proxies `/api` to `http://localhost:3000`. The backend
creates the MySQL schema at startup.

Create the initial superadmin by setting `BOOTSTRAP_ADMIN_EMAIL` and
`BOOTSTRAP_ADMIN_PASSWORD` in `backend/.env`, then running:

```sh
npm run create:superadmin --prefix backend
```

Remove those bootstrap variables after setup.

## Railway deployment

The folders are independent projects, but the current deployment serves the
built web app and API from one Railway service:

- Keep Railway's **Root Directory** set to the repository root.
- Set Railway's **Config File** to `backend/railway.json`.
- Set the build command to install and build both projects:
  `npm ci --prefix frontend && npm run build --prefix frontend && npm ci --prefix backend`
- Set the start command to `npm start --prefix backend`.
- Keep the health check path `/api/health`.
- Set `MYSQL_URL` to a Railway MySQL service variable reference, and set
  `APP_URL` to the public HTTPS origin. Add optional mail and Google Maps
  variables in Railway's service Variables.

Do not deploy with `backend/` as Railway's Root Directory for this combined
setup: the backend serves the built assets from its sibling `frontend/`
directory.

## Mobile and device clients

The API is available under `/api`. Mobile and firmware clients should use the
following API routes:

- `POST /api/auth/register` creates a pending account.
- `POST /api/device/registrations` registers a device for an owned farm and
  requires a signed-in session.
- `POST /api/device/readings` and `POST /api/device/state` use
  `X-Device-Id` and `X-Device-Token` headers.

Example firmware payloads:

```json
{ "readings": [{ "parameter": "temperature", "value": 28.4, "createdAt": "2026-01-01T00:00:00.000Z" }] }
```

```json
{ "stateKey": "battery", "value": { "percent": 90 } }
```

Register devices and provision their per-device token in the superadmin Device
Registry. The token is displayed once and stored hashed by the API.

## Firebase export import

The importer accepts prepared Firebase JSON exports with `users`, `collections`,
`readings`, and `deviceState` properties. Run it from the repository root:

```sh
npm run import:data --prefix backend -- path/to/prepared-export.json
```

Set `MYSQL_URL` or the individual MySQL variables in `backend/.env` first.
Imported Firebase passwords are not retained; imported users must use password
reset to set a new password.


## HyQual MySQL schema and demo seed

The backend now uses the relational tables in `schema.sql` directly (accounts, user_profiles,
aquaculture_farms, ponds, monitoring_devices, device_status, device_maintenance,
water_quality_readings, water_quality_forecasts, parameter_thresholds,
early_warning_notifications, activity_logs, and password_resets).

For a **new empty MySQL database**, run `schema.sql` first and then `seed_data.sql` against
the same database. The application creates missing schema tables at startup, but deliberately
does not automatically import demo seed rows into a live database. Do not run the seed repeatedly
unless you have cleared the existing demo rows first.

Website features that require storage not present in the supplied schema (for example online
presence tracking and queued email delivery) are left disabled rather than creating extra tables.
The website's supported farms, ponds, devices, readings, alerts, account, and audit-log APIs map
to the supplied schema. Fields not represented by that schema (such as farm map latitude/longitude)
are not persisted by these APIs.
