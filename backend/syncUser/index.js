const { CosmosClient } = require('@azure/cosmos');

let cosmosDbInstance = null;

function getCosmosDatabase() {
  if (cosmosDbInstance) {
    return cosmosDbInstance;
  }

  const connectionString =
    process.env.COSMOS_CONNECTION_STRING || process.env.COSMOS_DB_CONNECTION_STRING;
  const endpoint = process.env.COSMOS_DB_ENDPOINT;
  const key = process.env.COSMOS_DB_KEY;

  let client;
  if (connectionString) {
    client = new CosmosClient(connectionString);
  } else if (endpoint && key) {
    client = new CosmosClient({ endpoint, key });
  } else {
    throw new Error(
      'Cosmos DB connection details missing. Set COSMOS_CONNECTION_STRING or COSMOS_DB_ENDPOINT & COSMOS_DB_KEY.'
    );
  }

  cosmosDbInstance = client.database('slate-db');
  return cosmosDbInstance;
}

module.exports = async function (context, req) {
  try {
    // 1. Read the x-ms-client-principal header (case-insensitive)
    const headers = req.headers || {};
    const principalHeader =
      headers['x-ms-client-principal'] ||
      headers['X-MS-CLIENT-PRINCIPAL'] ||
      context.req?.headers?.['x-ms-client-principal'];

    if (!principalHeader) {
      context.res = {
        status: 401,
        headers: { 'Content-Type': 'application/json' },
        body: { error: 'Missing x-ms-client-principal header.' }
      };
      return;
    }

    // 2. Decode base64 header to extract userId and userDetails (username)
    let clientPrincipal;
    try {
      const decoded = Buffer.from(principalHeader, 'base64').toString('utf8');
      clientPrincipal = JSON.parse(decoded);
    } catch (parseErr) {
      context.res = {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
        body: { error: 'Failed to decode x-ms-client-principal header.' }
      };
      return;
    }

    const userId = clientPrincipal.userId;
    const username = clientPrincipal.userDetails;

    if (!userId || !username) {
      context.res = {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
        body: { error: 'Client principal missing userId or userDetails.' }
      };
      return;
    }

    // 3. Connect to Cosmos DB instance and container 'users'
    const db = getCosmosDatabase();
    try {
      await db.containers.createIfNotExists({ id: 'users', partitionKey: '/id' });
    } catch (createErr) {
      // Proceed if container already exists
    }
    const container = db.container('users');

    // 4. Query to check if the user already exists to preserve 'following' array
    let existingFollowing = [];
    try {
      const querySpec = {
        query: 'SELECT * FROM c WHERE c.id = @id',
        parameters: [{ name: '@id', value: userId }]
      };
      const { resources } = await container.items.query(querySpec).fetchAll();
      if (resources && resources.length > 0 && Array.isArray(resources[0].following)) {
        existingFollowing = resources[0].following;
      }
    } catch (readErr) {
      context.log ? context.log('Error checking existing user:', readErr) : console.log(readErr);
    }

    // 5. Upsert user document according to specified schema
    const userDoc = {
      id: userId,
      username: username,
      following: existingFollowing,
      lastLogin: new Date().toISOString()
    };

    const { resource: upsertedUser } = await container.items.upsert(userDoc);

    context.res = {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
      body: {
        message: 'User synced successfully.',
        user: upsertedUser
      }
    };
  } catch (err) {
    const errorMsg = err.message || 'Internal server error syncing user.';
    context.log ? context.log('Error syncing user:', err) : console.error('Error syncing user:', err);
    context.res = {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
      body: { error: errorMsg }
    };
  }
};
