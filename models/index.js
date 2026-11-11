/** Registers every model with Mongoose so indexes are built at startup. */
module.exports = {
  User: require('./User'),
  Issue: require('./Issue'),
  RawData: require('./RawData'),
};
