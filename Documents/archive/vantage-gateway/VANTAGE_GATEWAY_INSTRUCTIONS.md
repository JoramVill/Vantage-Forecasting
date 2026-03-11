# Vantage-Gateway: Server Setup and API Implementation

## Objective

Set up the Vantage-Gateway server on an existing Debian LXC container to:
1. Receive forecast CSV files via SFTP from Vantage-Forecaster
2. Serve files to Apollo clients via authenticated REST API
3. Expose the API publicly via Tailscale Funnel

---

## Context

### What is Vantage-Gateway?
Vantage-Gateway is the central distribution point for forecast files. It receives files from the internal Vantage-Forecaster system and serves them to external Apollo client applications with tier-based access control.

### Current State
- Debian LXC container exists on Proxmox host
- Tailscale is already installed and configured
- Docker is available (but not required for this project)
- No file serving or API infrastructure exists

### Target State
- SFTP endpoint for receiving uploads from Vantage-Forecaster
- Node.js Express API (Gatekeeper) for authenticated file access
- Tailscale Funnel exposing API publicly over HTTPS
- Systemd service for automatic startup

---

## Server Details

| Property | Value |
|----------|-------|
| **Container** | vantage-gateway |
| **Local IP** | 10.0.0.36 |
| **Tailscale IP** | 100.115.9.94 |
| **Gateway** | 10.0.0.1 |
| **OS** | Debian GNU/Linux |

---

## Implementation Tasks

### Task 1: System Preparation

SSH into the container and prepare the system:

```bash
# Update system packages
apt update && apt upgrade -y

# Install required packages
apt install -y openssh-server curl git

# Install Node.js 20.x
curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
apt install -y nodejs

# Verify installation
node --version  # Should be v20.x
npm --version
```

---

### Task 2: Create Directory Structure

```bash
# Create main application directories
mkdir -p /opt/vantage/{csv_storage,gatekeeper,scripts,logs,backups}

# Create file storage subdirectories
mkdir -p /opt/vantage/csv_storage/{demand/regional,demand/zonal,cfac,archive,other}

# Set base permissions
chmod -R 755 /opt/vantage
```

**Directory Structure:**
```
/opt/vantage/
├── csv_storage/          # File storage root
│   ├── demand/
│   │   ├── regional/     # FC_DEM_*.csv
│   │   └── zonal/        # FC_ZDEM_*.csv
│   ├── cfac/             # FC_CF_*.csv
│   ├── archive/          # Old files (auto-moved)
│   └── other/            # Uncategorized files
├── gatekeeper/           # Node.js API application
│   ├── server.js
│   ├── config.json
│   ├── package.json
│   └── node_modules/
├── scripts/              # Maintenance scripts
│   ├── archive-old.sh
│   └── backup-config.sh
├── logs/                 # Application logs
│   ├── access.log
│   ├── gatekeeper.log
│   └── gatekeeper-error.log
└── backups/              # Config backups
```

---

### Task 3: Configure SFTP User

Create a dedicated user for SFTP uploads with restricted access:

```bash
# Create user with no shell access
useradd -m -d /opt/vantage/csv_storage -s /usr/sbin/nologin vantage-upload

# Set a strong password (you'll provide this to Vantage-Forecaster)
passwd vantage-upload
# Enter password when prompted

# Set correct ownership for chroot
# Root must own the chroot directory
chown root:root /opt/vantage/csv_storage
chmod 755 /opt/vantage/csv_storage

# User owns the subdirectories where they can write
chown -R vantage-upload:vantage-upload /opt/vantage/csv_storage/demand
chown -R vantage-upload:vantage-upload /opt/vantage/csv_storage/cfac
chown -R vantage-upload:vantage-upload /opt/vantage/csv_storage/archive
chown -R vantage-upload:vantage-upload /opt/vantage/csv_storage/other
```

---

### Task 4: Configure SSH for SFTP-Only Access

Edit SSH configuration to restrict the upload user:

```bash
# Backup original config
cp /etc/ssh/sshd_config /etc/ssh/sshd_config.backup

# Add SFTP restriction at end of file
cat >> /etc/ssh/sshd_config << 'EOF'

# Vantage SFTP Configuration
Match User vantage-upload
    ChrootDirectory /opt/vantage/csv_storage
    ForceCommand internal-sftp
    AllowTcpForwarding no
    X11Forwarding no
    PasswordAuthentication yes
EOF

# Restart SSH service
systemctl restart sshd

# Verify SSH is running
systemctl status sshd
```

**Test SFTP access** (from another machine on Tailscale):
```bash
sftp vantage-upload@100.115.9.94
# Should connect and be restricted to /opt/vantage/csv_storage
```

---

### Task 5: Initialize Gatekeeper API Project

```bash
cd /opt/vantage/gatekeeper

# Initialize Node.js project
npm init -y

# Install dependencies
npm install express cors helmet morgan jsonwebtoken dotenv

# Create package.json scripts
npm pkg set scripts.start="node server.js"
npm pkg set scripts.dev="node --watch server.js"
```

---

### Task 6: Create Configuration File

**File:** `/opt/vantage/gatekeeper/config.json`

```json
{
  "server": {
    "port": 8080,
    "host": "127.0.0.1"
  },
  "storage": {
    "basePath": "/opt/vantage/csv_storage",
    "archiveAfterDays": 30
  },
  "security": {
    "jwtSecret": "REPLACE_WITH_GENERATED_SECRET",
    "tokenExpiry": "24h",
    "rateLimit": {
      "windowMs": 3600000,
      "max": 100
    }
  },
  "clients": {
    "demo-client-abc123": {
      "name": "Demo Client",
      "tier": "premium",
      "enabled": true
    }
  },
  "tiers": {
    "basic": {
      "allowedPaths": ["demand/regional/*"],
      "rateLimit": 50
    },
    "standard": {
      "allowedPaths": ["demand/regional/*", "demand/zonal/*"],
      "rateLimit": 100
    },
    "premium": {
      "allowedPaths": ["demand/*", "cfac/*"],
      "rateLimit": 500
    },
    "enterprise": {
      "allowedPaths": ["*"],
      "rateLimit": 0
    }
  },
  "logging": {
    "accessLog": "/opt/vantage/logs/access.log",
    "errorLog": "/opt/vantage/logs/gatekeeper-error.log"
  }
}
```

**Generate a secure JWT secret:**
```bash
openssl rand -base64 32
# Copy output and paste into config.json jwtSecret field
```

---

### Task 7: Create Gatekeeper API Server

**File:** `/opt/vantage/gatekeeper/server.js`

```javascript
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const jwt = require('jsonwebtoken');
const fs = require('fs');
const path = require('path');

// Load configuration
const config = require('./config.json');

const app = express();

// Security middleware
app.use(helmet());
app.use(cors());
app.use(express.json());

// Access logging
const accessLogStream = fs.createWriteStream(config.logging.accessLog, { flags: 'a' });
app.use(morgan('combined', { stream: accessLogStream }));
app.use(morgan('dev')); // Console logging

// ============================================
// PUBLIC ENDPOINTS
// ============================================

// Health check
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    version: '1.0.0'
  });
});

// ============================================
// AUTHENTICATION
// ============================================

app.post('/auth/validate', (req, res) => {
  const { apiKey, clientId } = req.body;

  if (!apiKey) {
    return res.status(400).json({ error: 'API key is required' });
  }

  const client = config.clients[apiKey];
  if (!client || !client.enabled) {
    console.log(`[Auth] Invalid API key attempt: ${apiKey.substring(0, 8)}...`);
    return res.status(401).json({ error: 'Invalid API key' });
  }

  const tierConfig = config.tiers[client.tier];
  if (!tierConfig) {
    return res.status(500).json({ error: 'Invalid tier configuration' });
  }

  // Generate JWT token
  const token = jwt.sign(
    {
      apiKey: apiKey,
      clientName: client.name,
      tier: client.tier,
      clientId: clientId || 'unknown'
    },
    config.security.jwtSecret,
    { expiresIn: config.security.tokenExpiry }
  );

  console.log(`[Auth] Token issued for: ${client.name} (${client.tier})`);

  res.json({
    token,
    clientName: client.name,
    tier: client.tier,
    allowedPaths: tierConfig.allowedPaths,
    expiresIn: config.security.tokenExpiry
  });
});

// ============================================
// AUTHENTICATION MIDDLEWARE
// ============================================

const authenticate = (req, res, next) => {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Authorization token required' });
  }

  const token = authHeader.substring(7);

  try {
    const decoded = jwt.verify(token, config.security.jwtSecret);
    req.client = decoded;
    req.tierConfig = config.tiers[decoded.tier];
    next();
  } catch (err) {
    if (err.name === 'TokenExpiredError') {
      return res.status(401).json({ error: 'Token expired', code: 'TOKEN_EXPIRED' });
    }
    return res.status(401).json({ error: 'Invalid token' });
  }
};

// ============================================
// PATH AUTHORIZATION HELPER
// ============================================

function isPathAllowed(filePath, allowedPatterns) {
  const normalizedPath = filePath.replace(/\\/g, '/');

  for (const pattern of allowedPatterns) {
    // Convert glob pattern to regex
    const regexPattern = pattern
      .replace(/\*/g, '.*')
      .replace(/\//g, '\\/');

    const regex = new RegExp(`^${regexPattern}$`);

    if (regex.test(normalizedPath)) {
      return true;
    }
  }
  return false;
}

// ============================================
// FILE LISTING
// ============================================

app.get('/files/list', authenticate, (req, res) => {
  const { category, from, to, limit = 100 } = req.query;
  const files = [];

  function scanDirectory(dirPath, relativePath = '') {
    if (!fs.existsSync(dirPath)) return;

    const items = fs.readdirSync(dirPath);

    for (const item of items) {
      const fullPath = path.join(dirPath, item);
      const relPath = path.join(relativePath, item).replace(/\\/g, '/');
      const stat = fs.statSync(fullPath);

      if (stat.isDirectory()) {
        // Skip archive directory in normal listings
        if (item === 'archive') continue;
        scanDirectory(fullPath, relPath);
      } else if (item.endsWith('.csv')) {
        // Check authorization
        if (!isPathAllowed(relPath, req.tierConfig.allowedPaths)) {
          continue;
        }

        // Apply category filter
        if (category) {
          const fileCategory = getFileCategory(relPath);
          if (fileCategory !== category) continue;
        }

        // Apply date filters
        const modTime = stat.mtime;
        if (from && modTime < new Date(from)) continue;
        if (to && modTime > new Date(to)) continue;

        files.push({
          name: item,
          path: relPath,
          size: stat.size,
          modified: stat.mtime.toISOString(),
          category: getFileCategory(relPath)
        });
      }
    }
  }

  scanDirectory(config.storage.basePath);

  // Sort by modified date (newest first)
  files.sort((a, b) => new Date(b.modified) - new Date(a.modified));

  // Apply limit
  const limitedFiles = files.slice(0, parseInt(limit));

  res.json({
    files: limitedFiles,
    total: limitedFiles.length,
    hasMore: files.length > limitedFiles.length
  });
});

function getFileCategory(filePath) {
  if (filePath.startsWith('demand/regional')) return 'demand_regional';
  if (filePath.startsWith('demand/zonal')) return 'demand_zonal';
  if (filePath.startsWith('cfac')) return 'cfac';
  return 'other';
}

// ============================================
// GET LATEST FORECASTS
// ============================================

app.get('/files/latest', authenticate, (req, res) => {
  const latest = {};
  const categories = [
    { key: 'demand_regional', path: 'demand/regional' },
    { key: 'demand_zonal', path: 'demand/zonal' },
    { key: 'cfac', path: 'cfac' }
  ];

  for (const cat of categories) {
    // Check if category is allowed for this tier
    const isAllowed = req.tierConfig.allowedPaths.some(pattern => {
      return cat.path.startsWith(pattern.replace('/*', '').replace('*', ''));
    });

    if (!isAllowed) continue;

    const dirPath = path.join(config.storage.basePath, cat.path);
    if (!fs.existsSync(dirPath)) continue;

    const files = fs.readdirSync(dirPath)
      .filter(f => f.endsWith('.csv'))
      .map(f => {
        const stat = fs.statSync(path.join(dirPath, f));
        return {
          name: f,
          path: `${cat.path}/${f}`,
          size: stat.size,
          modified: stat.mtime
        };
      })
      .sort((a, b) => b.modified - a.modified);

    if (files.length > 0) {
      latest[cat.key] = {
        ...files[0],
        modified: files[0].modified.toISOString()
      };
    }
  }

  res.json({ latest });
});

// ============================================
// FILE DOWNLOAD
// ============================================

app.get('/files/download/*', authenticate, (req, res) => {
  const filePath = req.params[0];

  // Validate path
  if (!filePath) {
    return res.status(400).json({ error: 'File path required' });
  }

  // Security: prevent directory traversal
  const normalizedPath = path.normalize(filePath).replace(/^(\.\.[\/\\])+/, '');
  const fullPath = path.join(config.storage.basePath, normalizedPath);

  // Ensure path is within storage directory
  if (!fullPath.startsWith(config.storage.basePath)) {
    console.log(`[Security] Directory traversal attempt: ${filePath}`);
    return res.status(403).json({ error: 'Access denied' });
  }

  // Check tier authorization
  if (!isPathAllowed(normalizedPath, req.tierConfig.allowedPaths)) {
    return res.status(403).json({
      error: 'File not available for your license tier',
      tier: req.client.tier
    });
  }

  // Check file exists
  if (!fs.existsSync(fullPath)) {
    return res.status(404).json({ error: 'File not found' });
  }

  // Log download
  console.log(`[Download] ${normalizedPath} by ${req.client.clientName} (${req.client.tier})`);

  // Send file
  res.download(fullPath, path.basename(fullPath), (err) => {
    if (err && !res.headersSent) {
      console.error(`[Download Error] ${err.message}`);
      res.status(500).json({ error: 'Download failed' });
    }
  });
});

// ============================================
// ERROR HANDLING
// ============================================

app.use((err, req, res, next) => {
  console.error(`[Error] ${err.stack}`);
  res.status(500).json({ error: 'Internal server error' });
});

// 404 handler
app.use((req, res) => {
  res.status(404).json({ error: 'Endpoint not found' });
});

// ============================================
// START SERVER
// ============================================

const { port, host } = config.server;

app.listen(port, host, () => {
  console.log('='.repeat(50));
  console.log('Vantage Gatekeeper API');
  console.log('='.repeat(50));
  console.log(`Server:    http://${host}:${port}`);
  console.log(`Storage:   ${config.storage.basePath}`);
  console.log(`Clients:   ${Object.keys(config.clients).length} configured`);
  console.log('='.repeat(50));
});
```

---

### Task 8: Create Systemd Service

**File:** `/etc/systemd/system/gatekeeper.service`

```ini
[Unit]
Description=Vantage Gatekeeper API
After=network.target

[Service]
Type=simple
User=root
WorkingDirectory=/opt/vantage/gatekeeper
ExecStart=/usr/bin/node server.js
Restart=on-failure
RestartSec=10
StandardOutput=append:/opt/vantage/logs/gatekeeper.log
StandardError=append:/opt/vantage/logs/gatekeeper-error.log
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
```

**Enable and start the service:**
```bash
# Reload systemd
systemctl daemon-reload

# Enable auto-start on boot
systemctl enable gatekeeper

# Start the service
systemctl start gatekeeper

# Check status
systemctl status gatekeeper

# View logs
journalctl -u gatekeeper -f
```

---

### Task 9: Configure Tailscale Funnel

Expose the API publicly via Tailscale Funnel:

```bash
# Check Tailscale status
tailscale status

# Enable Funnel for port 8080
tailscale funnel 8080

# Verify Funnel configuration
tailscale funnel status
```

**Expected output:**
```
# Funnel status
https://vantage-gateway.<tailnet>.ts.net/
|-- proxy http://127.0.0.1:8080
```

**Test public access:**
```bash
# From any internet-connected machine
curl https://vantage-gateway.<your-tailnet>.ts.net/health
```

---

### Task 10: Create Maintenance Scripts

**File:** `/opt/vantage/scripts/archive-old.sh`

```bash
#!/bin/bash
# Archive files older than 30 days

STORAGE_DIR="/opt/vantage/csv_storage"
ARCHIVE_DIR="$STORAGE_DIR/archive"
DAYS_OLD=30

echo "[$(date)] Starting archive job..."

find "$STORAGE_DIR/demand" "$STORAGE_DIR/cfac" -name "*.csv" -type f -mtime +$DAYS_OLD | while read file; do
    filename=$(basename "$file")
    echo "Archiving: $filename"
    mv "$file" "$ARCHIVE_DIR/$filename"
done

echo "[$(date)] Archive job complete"
```

**File:** `/opt/vantage/scripts/backup-config.sh`

```bash
#!/bin/bash
# Backup configuration daily

CONFIG_FILE="/opt/vantage/gatekeeper/config.json"
BACKUP_DIR="/opt/vantage/backups"
DATE=$(date +%Y%m%d)

cp "$CONFIG_FILE" "$BACKUP_DIR/config-$DATE.json"

# Keep only last 30 backups
find "$BACKUP_DIR" -name "config-*.json" -mtime +30 -delete

echo "[$(date)] Config backed up to config-$DATE.json"
```

**Make scripts executable and add to cron:**
```bash
chmod +x /opt/vantage/scripts/*.sh

# Add to crontab
crontab -e

# Add these lines:
# Archive old files daily at 2 AM
0 2 * * * /opt/vantage/scripts/archive-old.sh >> /opt/vantage/logs/archive.log 2>&1

# Backup config daily at 3 AM
0 3 * * * /opt/vantage/scripts/backup-config.sh >> /opt/vantage/logs/backup.log 2>&1
```

---

### Task 11: Configure Log Rotation

**File:** `/etc/logrotate.d/vantage`

```
/opt/vantage/logs/*.log {
    daily
    rotate 30
    compress
    delaycompress
    missingok
    notifempty
    create 644 root root
    postrotate
        systemctl reload gatekeeper > /dev/null 2>&1 || true
    endscript
}
```

---

## Client Management

### Adding a New Client

1. Generate a unique API key:
   ```bash
   openssl rand -hex 16
   # Example output: a1b2c3d4e5f67890a1b2c3d4e5f67890
   ```

2. Add to config.json:
   ```json
   "clients": {
     "existing-client-key": { ... },
     "a1b2c3d4e5f67890a1b2c3d4e5f67890": {
       "name": "New Client Company",
       "tier": "standard",
       "enabled": true
     }
   }
   ```

3. Restart Gatekeeper:
   ```bash
   systemctl restart gatekeeper
   ```

4. Provide client with:
   - API Key: `a1b2c3d4e5f67890a1b2c3d4e5f67890`
   - Gateway URL: `https://vantage-gateway.<tailnet>.ts.net`

### Disabling a Client

Set `"enabled": false` in the client config and restart.

---

## Testing Checklist

- [ ] SSH/SFTP works for vantage-upload user
- [ ] SFTP user cannot access shell or other directories
- [ ] Gatekeeper service starts on boot
- [ ] Health endpoint responds: `GET /health`
- [ ] Authentication works with valid API key
- [ ] Authentication rejects invalid API key
- [ ] File listing shows correct files for tier
- [ ] Basic tier cannot see premium files
- [ ] File download works
- [ ] Directory traversal is blocked
- [ ] Tailscale Funnel serves HTTPS correctly
- [ ] Public URL accessible from internet
- [ ] Logs are written correctly
- [ ] Log rotation is configured

---

## Quick Test Commands

```bash
# Test health (no auth)
curl http://localhost:8080/health

# Test authentication
TOKEN=$(curl -s -X POST http://localhost:8080/auth/validate \
  -H "Content-Type: application/json" \
  -d '{"apiKey": "demo-client-abc123"}' | jq -r '.token')

echo "Token: $TOKEN"

# Test file listing
curl -s http://localhost:8080/files/list \
  -H "Authorization: Bearer $TOKEN" | jq

# Test latest forecasts
curl -s http://localhost:8080/files/latest \
  -H "Authorization: Bearer $TOKEN" | jq

# Test file download
curl -O http://localhost:8080/files/download/demand/regional/FC_DEM_2026-02-27.csv \
  -H "Authorization: Bearer $TOKEN"

# Test via Tailscale Funnel (public)
curl https://vantage-gateway.<tailnet>.ts.net/health
```

---

## Troubleshooting

### SFTP Connection Refused
```bash
# Check SSH service
systemctl status sshd

# Check firewall
ufw status

# Test locally
sftp vantage-upload@localhost
```

### Gatekeeper Won't Start
```bash
# Check logs
journalctl -u gatekeeper -n 50

# Check syntax errors
node /opt/vantage/gatekeeper/server.js

# Check config.json is valid JSON
jq . /opt/vantage/gatekeeper/config.json
```

### Funnel Not Working
```bash
# Check Tailscale status
tailscale status

# Re-enable funnel
tailscale funnel off
tailscale funnel 8080

# Check funnel status
tailscale funnel status
```

---

## Security Notes

1. **JWT Secret**: Keep the JWT secret secure. If compromised, regenerate and restart.

2. **API Keys**: Treat like passwords. Generate unique keys per client.

3. **SFTP User**: The vantage-upload user has no shell access and is chrooted.

4. **Firewall**: The API only binds to localhost; Tailscale Funnel handles public access.

5. **Logs**: Monitor access logs for suspicious activity.

---

## Notes

- This is Phases 1-3 of the overall Distribution Planner project
- Vantage-Forecaster and Apollo implementations are handled separately
- Replace `<tailnet>` with your actual Tailscale network name
- The SFTP password for vantage-upload must be shared securely with Vantage-Forecaster
