const { app } = require('@azure/functions');
const { CosmosClient } = require('@azure/cosmos');
const { QueueServiceClient } = require('@azure/storage-queue');
const { randomUUID } = require('crypto');

// -----------------------------------------------------------------------------
// Database & Storage Helper Clients
// -----------------------------------------------------------------------------
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

function getQueueClient(queueName = 'activity-events') {
  const connectionString =
    process.env.STORAGE_CONNECTION_STRING || process.env.AzureWebJobsStorage;

  if (!connectionString) {
    throw new Error(
      'Storage connection string missing. Set STORAGE_CONNECTION_STRING or AzureWebJobsStorage.'
    );
  }

  const queueServiceClient = QueueServiceClient.fromConnectionString(connectionString);
  return queueServiceClient.getQueueClient(queueName);
}

// -----------------------------------------------------------------------------
// 1. searchFilms (HTTP GET)
// -----------------------------------------------------------------------------
app.http('searchFilms', {
  methods: ['GET'],
  authLevel: 'anonymous',
  handler: async (request, context) => {
    try {
      const query = request.query.get('query');

      if (!query || !query.trim()) {
        return {
          status: 400,
          jsonBody: {
            error: "Query parameter 'query' is required."
          }
        };
      }

      const apiKey = process.env.TMDB_API_KEY;
      if (!apiKey) {
        return {
          status: 500,
          jsonBody: {
            error: 'TMDB_API_KEY environment variable is not configured.'
          }
        };
      }

      const url = `https://api.themoviedb.org/3/search/movie?api_key=${encodeURIComponent(
        apiKey
      )}&query=${encodeURIComponent(query.trim())}&include_adult=false&language=en-US&page=1`;

      const response = await fetch(url, {
        method: 'GET',
        headers: {
          Accept: 'application/json'
        }
      });

      if (!response.ok) {
        const errorText = await response.text();
        return {
          status: response.status,
          jsonBody: {
            error: `TMDB API returned error (${response.status}): ${errorText}`
          }
        };
      }

      const data = await response.json();

      return {
        status: 200,
        headers: {
          'Content-Type': 'application/json'
        },
        jsonBody: data
      };
    } catch (err) {
      context.error('Error executing searchFilms:', err);
      return {
        status: 500,
        jsonBody: {
          error: err.message || 'Internal server error while searching films.'
        }
      };
    }
  }
});

// -----------------------------------------------------------------------------
// 2. logFilm (HTTP POST)
// -----------------------------------------------------------------------------
app.http('log', {
  methods: ['POST'],
  authLevel: 'anonymous',
  handler: async (request, context) => {
    try {
      let body;
      try {
        body = await request.json();
      } catch {
        return {
          status: 400,
          jsonBody: {
            error: 'Invalid JSON payload in request body.'
          }
        };
      }

      if (!body || typeof body !== 'object' || Array.isArray(body)) {
        return {
          status: 400,
          jsonBody: {
            error: 'Request body must be a valid JSON object.'
          }
        };
      }

      if (!body.userId) {
        return {
          status: 400,
          jsonBody: {
            error: "Field 'userId' is required (partition key for logs container)."
          }
        };
      }

      const logRecord = {
        id: body.id || randomUUID(),
        userId: body.userId,
        filmId: body.filmId || null,
        filmTitle: body.filmTitle || body.title || null,
        rating: body.rating !== undefined ? body.rating : null,
        review: body.review || null,
        loggedAt: body.loggedAt || new Date().toISOString(),
        ...body
      };

      // 1. Save log record into Cosmos DB 'logs' container
      const db = getCosmosDatabase();
      const logsContainer = db.container('logs');
      const { resource: createdLog } = await logsContainer.items.create(logRecord);

      // 2. Push event payload to 'activity-events' storage queue
      const queueClient = getQueueClient('activity-events');
      await queueClient.createIfNotExists();

      const eventPayload = {
        eventId: randomUUID(),
        eventType: 'FILM_LOGGED',
        userId: createdLog.userId,
        filmId: createdLog.filmId,
        filmTitle: createdLog.filmTitle,
        logId: createdLog.id,
        timestamp: new Date().toISOString()
      };

      // Azure Functions queue triggers expect base64-encoded queue messages
      const base64Message = Buffer.from(JSON.stringify(eventPayload)).toString('base64');
      await queueClient.sendMessage(base64Message);

      return {
        status: 201,
        headers: {
          'Content-Type': 'application/json'
        },
        jsonBody: {
          message: 'Film log saved and activity event queued successfully.',
          log: createdLog,
          event: eventPayload
        }
      };
    } catch (err) {
      context.error('Error executing logFilm:', err);
      return {
        status: 500,
        jsonBody: {
          error: err.message || 'Internal server error while logging film.'
        }
      };
    }
  }
});

// -----------------------------------------------------------------------------
// 3. feedWorker (Queue Trigger)
// -----------------------------------------------------------------------------
app.storageQueue('feedWorker', {
  queueName: 'activity-events',
  connection: 'AzureWebJobsStorage',
  handler: async (queueItem, context) => {
    try {
      context.log('feedWorker received item:', queueItem);

      let payload = queueItem;
      if (typeof queueItem === 'string') {
        try {
          payload = JSON.parse(queueItem);
        } catch {
          payload = { rawMessage: queueItem };
        }
      }

      // Partition key for feed container is '/ownerId'
      const ownerId = payload.userId || payload.ownerId || 'user-default';

      const dummyFeedEntry = {
        id: randomUUID(),
        ownerId: ownerId,
        activityType: payload.eventType || 'FILM_LOGGED',
        filmId: payload.filmId || 'sample-film-id',
        filmTitle: payload.filmTitle || 'Sample Movie Title',
        feedMessage: `User ${ownerId} logged a film: ${payload.filmTitle || 'Unknown Title'}`,
        sourceEventId: payload.eventId || null,
        createdAt: new Date().toISOString()
      };

      const db = getCosmosDatabase();
      const feedContainer = db.container('feed');
      const { resource: createdFeed } = await feedContainer.items.create(dummyFeedEntry);

      context.log(
        `Successfully generated feed entry ${createdFeed.id} for owner ${createdFeed.ownerId}`
      );
    } catch (err) {
      context.error('Error processing feedWorker queue item:', err);
      throw err; // Rethrow to ensure message retry / poison queue handling
    }
  }
});

// -----------------------------------------------------------------------------
// 4. getFeed (HTTP GET) - REBUILT FOR SOCIAL GRAPH
// -----------------------------------------------------------------------------
app.http('getFeed', {
  methods: ['GET'],
  authLevel: 'anonymous',
  handler: async (request, context) => {
    try {
      const db = getCosmosDatabase();
      const usersContainer = db.container('users');
      const logsContainer = db.container('logs');

      // 1. Identify the user asking for the feed
      const principalHeader = request.headers.get('x-ms-client-principal') || request.headers.get('X-MS-CLIENT-PRINCIPAL');

      // If not logged in, return an empty feed rather than global feed
      if (!principalHeader) {
        return { status: 200, headers: { 'Content-Type': 'application/json' }, jsonBody: [] };
      }

      const decoded = Buffer.from(principalHeader, 'base64').toString('utf8');
      const currentUserId = JSON.parse(decoded).userId;

      // 2. Look up who they follow
      let followingIds = [];
      try {
        const { resource: userProfile } = await usersContainer.item(currentUserId, currentUserId).read();
        if (userProfile && Array.isArray(userProfile.following)) {
          followingIds = userProfile.following;
        }
      } catch (err) {
        context.log('User profile not found, defaulting to empty following list.');
      }

      // Add self to the feed so they see their own posts
      followingIds.push(currentUserId);

      // 3. Query the LOGS container (not the feed queue) for immediate, accurate data
      // We construct a dynamic SQL query based on the following array
      const quotedIds = followingIds.map(id => `'${id}'`).join(',');
      const querySpec = {
        query: `SELECT TOP 20 * FROM c WHERE c.userId IN (${quotedIds}) ORDER BY c.loggedAt DESC`
      };

      const { resources: directLogs } = await logsContainer.items.query(querySpec).fetchAll();

      // 4. Map the raw logs into the exact format the frontend expects
      const formattedFeed = directLogs.map(log => ({
        id: log.id,
        ownerId: log.userId,
        userId: log.userId,
        filmTitle: log.filmTitle,
        year: log.year,
        posterPath: log.posterPath || log.thumbUrl,
        rating: log.rating,
        review: log.review,
        createdAt: log.loggedAt
      }));

      return {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
        jsonBody: formattedFeed
      };
    } catch (err) {
      context.error('Error fetching personalized feed:', err);
      return { status: 500, jsonBody: { error: 'Failed to retrieve personalized feed.' } };
    }
  }
});


// -----------------------------------------------------------------------------
// 5. syncUser (HTTP GET & POST)
// -----------------------------------------------------------------------------
app.http('syncUser', {
  methods: ['GET', 'POST'],
  authLevel: 'anonymous',
  handler: async (request, context) => {
    try {
      // 1. Read x-ms-client-principal header (from Azure SWA)
      const principalHeader =
        request.headers.get('x-ms-client-principal') ||
        request.headers.get('X-MS-CLIENT-PRINCIPAL');

      if (!principalHeader) {
        return {
          status: 401,
          headers: { 'Content-Type': 'application/json' },
          jsonBody: { error: 'Missing x-ms-client-principal header.' }
        };
      }

      // 2. Decode base64 header
      let clientPrincipal;
      try {
        const decoded = Buffer.from(principalHeader, 'base64').toString('utf8');
        clientPrincipal = JSON.parse(decoded);
      } catch (parseErr) {
        return {
          status: 400,
          headers: { 'Content-Type': 'application/json' },
          jsonBody: { error: 'Failed to decode x-ms-client-principal header.' }
        };
      }

      const userId = clientPrincipal.userId;
      const username = clientPrincipal.userDetails;

      if (!userId || !username) {
        return {
          status: 400,
          headers: { 'Content-Type': 'application/json' },
          jsonBody: { error: 'Client principal missing userId or userDetails.' }
        };
      }

      // 3. Connect to Cosmos DB instance and container 'users'
      const db = getCosmosDatabase();
      try {
        await db.containers.createIfNotExists({ id: 'users', partitionKey: '/id' });
      } catch (createErr) {
        // Container may already exist
      }
      const container = db.container('users');

      // 4. Query to preserve existing 'following' array if user already exists
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
        context.error('Error checking existing user in Cosmos DB:', readErr);
      }

      // 5. Upsert user document
      const userDoc = {
        id: userId,
        username: username,
        following: existingFollowing,
        lastLogin: new Date().toISOString()
      };

      const { resource: upsertedUser } = await container.items.upsert(userDoc);

      return {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
        jsonBody: {
          message: 'User synced successfully.',
          user: upsertedUser
        }
      };
    } catch (err) {
      context.error('Error syncing user:', err);
      return {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
        jsonBody: { error: err.message || 'Internal server error syncing user.' }
      };
    }
  }
});

// -----------------------------------------------------------------------------
// 6. toggleFollow (HTTP POST)
// -----------------------------------------------------------------------------
app.http('toggleFollow', {
  methods: ['POST'],
  authLevel: 'anonymous',
  handler: async (request, context) => {
    try {
      // 1. Authenticate the request
      const principalHeader = request.headers.get('x-ms-client-principal') || request.headers.get('X-MS-CLIENT-PRINCIPAL');
      if (!principalHeader) {
        return { status: 401, jsonBody: { error: 'Unauthorized. Missing auth header.' } };
      }

      const decoded = Buffer.from(principalHeader, 'base64').toString('utf8');
      const clientPrincipal = JSON.parse(decoded);
      const currentUserId = clientPrincipal.userId;

      // 2. Parse the target user and action from the frontend
      const body = await request.json();
      const targetUserId = body.targetUserId;
      const action = body.action; // Expects 'follow' or 'unfollow'

      if (!targetUserId || !action) {
        return { status: 400, jsonBody: { error: 'Missing targetUserId or action in request body.' } };
      }

      // 3. Fetch current user from Cosmos DB
      const db = getCosmosDatabase();
      const container = db.container('users');

      const { resource: userProfile } = await container.item(currentUserId, currentUserId).read();
      if (!userProfile) {
        return { status: 404, jsonBody: { error: 'Your user profile was not found in the database.' } };
      }

      // 4. Modify the following array
      let following = userProfile.following || [];
      if (action === 'follow' && !following.includes(targetUserId)) {
        following.push(targetUserId);
      } else if (action === 'unfollow') {
        following = following.filter(id => id !== targetUserId);
      }

      // 5. Save the updated profile back to the database
      userProfile.following = following;
      const { resource: updatedUser } = await container.items.upsert(userProfile);

      return {
        status: 200,
        jsonBody: {
          message: `Successfully executed ${action}.`,
          following: updatedUser.following
        }
      };
    } catch (err) {
      context.error('Error in toggleFollow:', err);
      return { status: 500, jsonBody: { error: 'Internal server error while updating social graph.' } };
    }
  }
});

// -----------------------------------------------------------------------------
// 7. getUserLogs (HTTP GET) - FOR PROFILE GRID
// -----------------------------------------------------------------------------
app.http('getUserLogs', {
  methods: ['GET'],
  authLevel: 'anonymous',
  handler: async (request, context) => {
    try {
      const username = request.query.get('username');
      if (!username) return { status: 400, jsonBody: { error: 'Username required' } };

      const db = getCosmosDatabase();
      const querySpec = {
        query: `SELECT * FROM c WHERE c.userId = @uid ORDER BY c.loggedAt DESC`,
        parameters: [{ name: '@uid', value: username }]
      };

      const { resources } = await db.container('logs').items.query(querySpec).fetchAll();
      return { status: 200, headers: { 'Content-Type': 'application/json' }, jsonBody: resources };
    } catch (err) {
      context.error(err);
      return { status: 500, jsonBody: { error: 'Grid fetch failed' } };
    }
  }
});
