const { v4: uuidv4 } = require('uuid');

/**
 * Generate an offline user
 * @param {string} username - The username to use for offline mode
 * @returns {Object} - The offline user object
 */
function offline(username) {
  const uuid = uuidv4().replace(/-/g, '');
  return {
    name: username,
    id: uuid
  };
}

module.exports = { offline };