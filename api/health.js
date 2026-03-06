module.exports = (req, res) => {
  res.status(200).json({ status: 'ok', bot: 'reddit-strategy', timestamp: new Date().toISOString() });
};
