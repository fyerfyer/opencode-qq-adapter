# Long-running deployment (systemd user units)

These units assume the repository is at `~/Projects/opencode-qq-adapter`, Node is
installed at `~/.nvm/versions/node/v22.19.0/bin/node`, and the OpenCode binary is
`~/.opencode/bin/opencode`. Adjust the paths before installing.

```bash
cd ~/Projects/opencode-qq-adapter
pnpm install
pnpm build

mkdir -p ~/.config/systemd/user
cp deploy/systemd/opencode.service deploy/systemd/opencode-qq.service \
  ~/.config/systemd/user/

systemctl --user daemon-reload
systemctl --user enable --now opencode.service
systemctl --user enable --now opencode-qq.service

# Keep user services running after logout/reboot without an active login:
loginctl enable-linger "$USER"
```

Useful commands:

```bash
systemctl --user status opencode-qq.service
journalctl --user -u opencode-qq.service -f
systemctl --user restart opencode-qq.service
```

## Why QQ still asks for a QR code sometimes

The bridge process is not what logs out. NapCat holds the QQ login session. A
QR code is required again when QQ invalidates that session, for example after:

- logging the same QQ account in somewhere else or approving a new device;
- a long host/container outage, a clock/timezone jump, or too many restarts;
- QQ risk control on a new account or unusual network.

For a stable bot:

1. Use a dedicated QQ account, not your main account.
2. Keep the NapCat data volume (`data/napcat/qq`) persistent. This repo already
   mounts it; do not delete it during upgrades.
3. Keep the host clock/timezone correct and use `restart: unless-stopped`.
4. Keep the phone that owns the account available for the occasional QR scan.
5. Prefer a wired/stable network and avoid switching public IPs frequently.
6. Do not run a second NapCat instance for the same QQ account at the same time.

NapCat's container is already configured with `restart: unless-stopped` in
`docker-compose.yml`. The systemd units above make the bridge and OpenCode
service restart automatically as well.
