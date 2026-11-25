# Set up a Splitpage relay

## Build and run

From the Splitpage checkout, build the image with Docker.

```sh
docker build -f collab-server/Dockerfile -t splitpage-relay .
docker volume create splitpage-relay-data
```

Create a private environment file called `relay.env`. Set the public HTTPS
origin and a deployment identifier. Supply your own randomly generated
management secret through your secret store. Keep the environment file and
secret out of version control.

```dotenv
SPLITPAGE_ALLOWED_ORIGINS=https://relay.example.com,splitpage://app
SPLITPAGE_DEPLOYMENT_ID=example-deployment
```

Put `SPLITPAGE_MANAGEMENT_SECRET` in the private environment file before
running Docker. Use the image’s data directory as the
persistent volume mount.

```sh
data_dir=$(docker run --rm --entrypoint printenv splitpage-relay SPLITPAGE_DATA_DIR)
docker run -d --name splitpage-relay --env-file relay.env \
  --mount "type=volume,source=splitpage-relay-data,target=$data_dir" \
  --publish 127.0.0.1:8080:8080 splitpage-relay
```

Point a TLS reverse proxy or tunnel at loopback port 8080. Keep the backend
port private. Serve the relay’s HTTPS routes and forward WebSocket upgrades
on the same public origin so clients can connect over `wss:`. Preserve the
request’s `Origin` header and the response’s `Splitpage-Deployment` header.
Keep authentication headers and request bodies out of logs. If the tunnel
runs in Docker, use a private container network to reach the relay instead
of publishing its port.

In a collaboration-enabled desktop build, open **Settings ▸ Collaboration ▸
Set up relay…**. Enter the public HTTPS address and management secret, then
choose **Test connection**. The default Docker image serves the release
browser shell. Until collaboration ships, test browser invitations with a
matching collaboration-enabled shell on a private test endpoint.

## Settings

| Environment variable | Default | Purpose |
| --- | --- | --- |
| `SPLITPAGE_DATA_DIR` | Provided by the image | Required. Writable directory for the database, pictures and backups. |
| `SPLITPAGE_APP_DIR` | Provided by the image | Directory containing the browser shell. If unset, the relay serves no shell. |
| `SPLITPAGE_PORT` | `8080` | HTTP and WebSocket listening port. Use `0` for an automatically assigned test port. |
| `SPLITPAGE_ALLOWED_ORIGINS` | Required | Comma-separated exact origins, including the browser origin and `splitpage://app` for desktop. Include scheme and any explicit port. Leave out paths, trailing slashes and wildcards. |
| `SPLITPAGE_DEPLOYMENT_ID` | Unset | Required for clients to identify the deployment. Use 1–64 ASCII letters, digits, underscores or hyphens. Keep it stable through updates. Give independent relays distinct IDs. |
| `SPLITPAGE_MANAGEMENT_SECRET` | Unset | Enables owner management, script creation and private status. Supply a high-entropy secret. |
| `SPLITPAGE_STORE_DEBOUNCE_MS` | `2000` | Delay before persisting updates after editing pauses. |
| `SPLITPAGE_STORE_MAX_DEBOUNCE_MS` | `10000` | Maximum persistence delay while edits continue. At least the debounce. |
| `SPLITPAGE_MAX_CONNECTIONS` | `64` | Concurrent connection limit across the relay. |
| `SPLITPAGE_MAX_CONNECTIONS_PER_INVITATION` | `8` | Concurrent connections per invitation other than a guest invitation. |
| `SPLITPAGE_MAX_CONNECTIONS_PER_GUEST_INVITATION` | `24` | Concurrent connections sharing a guest invitation. |
| `SPLITPAGE_MAX_MESSAGES_PER_SECOND` | `60` | WebSocket message rate limit per connection. |
| `SPLITPAGE_MAX_UPLOADS_IN_FLIGHT` | `4` | Concurrent picture uploads. Range 1–4. |
| `SPLITPAGE_VERSION_INTERVAL_MS` | `300000` | Minimum interval between retained versions. |
| `SPLITPAGE_VERSION_THIN_INTERVAL_MS` | `3600000` | Spacing used when thinning older versions. |
| `SPLITPAGE_VERSION_BUDGET_BYTES` | `67108864` | Version storage budget in bytes. |
| `SPLITPAGE_BACKUP_KEEP` | `7` | Number of recent verified backups to retain locally. |

## Manage invitations

Run the owner command from the `collab-server` directory with Node 24.22.1
and `SPLITPAGE_MANAGEMENT_SECRET` in its environment. The command takes the
HTTPS origin.

```sh
node owner-command.ts https://relay.example.com scripts
node owner-command.ts https://relay.example.com list example-script
node owner-command.ts https://relay.example.com issue example-script guest "Example invitation"
node owner-command.ts https://relay.example.com reset example-script
node owner-command.ts https://relay.example.com revoke example-invitation
```

`scripts` lists scripts, and `list` lists a script’s invitations. `issue` creates
an invitation. Use `owner` as its role to issue an owner credential. `reset`
revokes existing guest links and issues a new one. `revoke` takes the invitation
ID from `list`. `delete <script-id>` stops sharing and deletes that script from
the relay. The output of `issue` and `reset` grants access. Share it privately
with the intended recipient.

## Back up and rehearse a restore

1. While the relay is running, run
   `docker exec splitpage-relay node backup-command.ts`. The command verifies
   the database and referenced pictures and prints the archive name. The
   archive sits under `backups` in the data directory.
2. Copy the entire archive directory off the relay host. Use the printed
   name in place of `<archive-name>` in
   `docker cp "splitpage-relay:$data_dir/backups/<archive-name>" .`.
   Keep the database and its picture files together. Restrict access to the
   backup as you would the live script data.
3. On an isolated host, mount the copied archive and a writable recovery volume
   into a container using the same image. Run
   `node restore-command.ts <backup-directory> <new-data-directory>` in that
   container. The destination must be a new directory with an existing writable
   parent. Make the archive readable by the account running the image.
   The command verifies the restored data and revokes all invitations.
4. Start a separate relay with `SPLITPAGE_DATA_DIR` pointing at the restored
   directory. Use a private test origin and a distinct deployment ID for the
   drill. List scripts, issue a fresh invitation and confirm from a separate
   device or browser profile that the script, pictures and version history
   open. Confirm a pre-restore invitation is refused.
5. For a real recovery, keep the recovered relay on its original deployment ID.
   Give collaborators fresh invitations before they reconnect.
