module.exports = {
  // Artillery processor hooks (no-op, kept for config compatibility)
  beforeRequest: (req, ctx, ee, next) => next(),
  afterResponse: (req, res, ctx, ee, next) => next(),
};
