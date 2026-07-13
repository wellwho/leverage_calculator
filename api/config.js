// Tells index.html which mode this deployment is running in. Public and
// tiny on purpose — no secrets, no MEXC calls — since it has to be reachable
// even on a demo project where nothing else is configured.
//
// GET /api/config -> { demoMode: boolean }

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.status(200).json({ demoMode: process.env.DEMO_MODE === 'true' });
};
