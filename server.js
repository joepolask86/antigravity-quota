const express = require('express');
const path = require('path');
const { fetchAllQuotas, addKnownAccount, loadKnownAccounts, removeKnownAccount, updateKnownAccount, getLastRawResponse, getAndClearNotifications } = require('./antigravity');

const app = express();
const PORT = process.env.PORT || 3001;
const POLL_INTERVAL = parseInt(process.env.POLL_INTERVAL) || 30000;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const cache = {
  accounts: [],
  lastUpdated: null,
  accountCount: 0,
  errors: [],
  polling: false,
};

async function poll() {
  cache.polling = true;
  try {
    const accounts = await fetchAllQuotas();
    cache.accounts = accounts;
    cache.lastUpdated = new Date().toISOString();
    cache.accountCount = accounts.filter(a => a.connected).length;
    cache.errors = [];
    console.log(`Poll: ${cache.accountCount} accounts, ${accounts.length} total`);
  } catch (err) {
    console.error('Poll error:', err.message);
    cache.errors.push({ time: new Date().toISOString(), message: err.message });
  } finally {
    cache.polling = false;
  }
}

app.get('/api/quota', (req, res) => {
  res.json({
    accounts: cache.accounts,
    lastUpdated: cache.lastUpdated,
    accountCount: cache.accountCount,
  });
});

app.post('/api/refresh', async (req, res) => {
  await poll();
  res.json({
    accounts: cache.accounts,
    lastUpdated: cache.lastUpdated,
    accountCount: cache.accountCount,
  });
});

app.get('/api/accounts', (req, res) => {
  res.json({ accounts: loadKnownAccounts() });
});

app.post('/api/accounts', (req, res) => {
  const { email } = req.body;
  if (!email || !/^[^\s@]+@[^\s@]+$/.test(email)) {
    return res.status(400).json({ error: 'Valid email required' });
  }
  console.log(`POST /api/accounts: ${email}`);
  addKnownAccount(email);
  const updated = loadKnownAccounts();
  console.log(`POST /api/accounts: now ${updated.length} accounts in data.json`);
  res.json({ success: true, accounts: updated });
});

app.get('/api/raw-response', (req, res) => {
  const raw = getLastRawResponse();
  res.json(raw || { error: 'No response captured yet' });
});

app.delete('/api/accounts/:email', (req, res) => {
  const email = decodeURIComponent(req.params.email);
  const ok = removeKnownAccount(email);
  if (!ok) return res.status(404).json({ error: 'Account not found' });
  console.log(`DELETE /api/accounts: ${email}`);
  res.json({ success: true, accounts: loadKnownAccounts() });
});

app.put('/api/accounts/:email', (req, res) => {
  const email = decodeURIComponent(req.params.email);
  const { name, newEmail } = req.body;
  const updates = {};
  if (name !== undefined) updates.name = name;
  if (newEmail !== undefined) {
    if (!/^[^\s@]+@[^\s@]+$/.test(newEmail)) {
      return res.status(400).json({ error: 'Valid email required' });
    }
    updates.email = newEmail;
  }
  const ok = updateKnownAccount(email, updates);
  if (!ok) return res.status(404).json({ error: 'Account not found' });
  console.log(`PUT /api/accounts: ${email} -> ${JSON.stringify(updates)}`);
  res.json({ success: true, accounts: loadKnownAccounts() });
});

app.get('/api/notifications', (req, res) => {
  res.json({ notifications: getAndClearNotifications() });
});

app.get('/api/status', (req, res) => {
  res.json({
    polling: cache.polling,
    lastUpdated: cache.lastUpdated,
    accountsFound: cache.accountCount,
    errors: cache.errors.slice(-5),
  });
});

poll().then(() => {
  setInterval(poll, POLL_INTERVAL);
});

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
