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
        username: body.username,
        filmId: body.filmId || null,
        filmTitle: body.filmTitle || body.title || null,
        year: body.year,
        posterPath: body.posterPath,
        rating: body.rating !== undefined ? body.rating : null,
        review: body.review || null,
        privateNote: body.privateNote || null,
        loggedAt: body.loggedAt || new Date().toISOString(), // The date you said you watched it
        createdAt: new Date().toISOString() // FIX: The exact millisecond you pressed "Log Film"
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
// 4. getFeed (HTTP GET) - REBUILT FOR SOCIAL GRAPH & SORTING
// -----------------------------------------------------------------------------
app.http('getFeed', {
  methods: ['GET'],
  authLevel: 'anonymous',
  handler: async (request, context) => {
    try {
      const db = getCosmosDatabase();
      const principalHeader = request.headers.get('x-ms-client-principal') || request.headers.get('X-MS-CLIENT-PRINCIPAL');
      if (!principalHeader) return { status: 200, headers: { 'Content-Type': 'application/json' }, jsonBody: [] };

      const currentUserId = JSON.parse(Buffer.from(principalHeader, 'base64').toString('utf8')).userId;

      let followingIds = [];
      try {
        const { resource: userProfile } = await db.container('users').item(currentUserId, currentUserId).read();
        if (userProfile && Array.isArray(userProfile.following)) followingIds = userProfile.following;
      } catch (err) { }
      followingIds.push(currentUserId);

      const quotedIds = followingIds.map(id => `'${id}'`).join(',');
      const querySpec = { query: `SELECT * FROM c WHERE c.userId IN (${quotedIds})` };
      const { resources: directLogs } = await db.container('logs').items.query(querySpec).fetchAll();

      // FIX: Sort exactly by the moment they pressed "Log Film" (createdAt), newest first
      directLogs.sort((a, b) => new Date(b.createdAt || b.loggedAt) - new Date(a.createdAt || a.loggedAt));

      // 4. Map the raw logs into the exact format the frontend expects
      const formattedFeed = directLogs.slice(0, 50).map(log => ({
        id: log.id,
        ownerId: log.userId, // FIX: Keep the GUID for security checks
        userId: log.userId,  // FIX: Keep the GUID for Private Note checks
        username: log.username, // Explicitly pass the display name
        filmId: log.filmId,
        filmTitle: log.filmTitle,
        year: log.year,
        posterPath: log.posterPath || log.thumbUrl,
        rating: log.rating,
        review: log.review,
        privateNote: log.privateNote, // FIX: Actually pass the private note to the frontend!
        createdAt: log.createdAt || log.loggedAt,
        loggedAt: log.loggedAt
      }));

      return { status: 200, headers: { 'Content-Type': 'application/json' }, jsonBody: formattedFeed };
    } catch (err) {
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
        query: `SELECT * FROM c WHERE LOWER(c.username) = LOWER(@uname)`,
        parameters: [{ name: '@uname', value: username }]
      };

      const { resources } = await db.container('logs').items.query(querySpec).fetchAll();

      // FIX: Sort exactly by the moment they pressed "Log Film"
      resources.sort((a, b) => new Date(b.createdAt || b.loggedAt) - new Date(a.createdAt || a.loggedAt));

      return { status: 200, headers: { 'Content-Type': 'application/json' }, jsonBody: resources };
    } catch (err) {
      return { status: 500, jsonBody: { error: 'Grid fetch failed' } };
    }
  }
});

// -----------------------------------------------------------------------------
// 8. toggleWatchlist (HTTP POST)
// -----------------------------------------------------------------------------
app.http('toggleWatchlist', {
  methods: ['POST'],
  authLevel: 'anonymous',
  handler: async (request, context) => {
    try {
      const principalHeader = request.headers.get('x-ms-client-principal') || request.headers.get('X-MS-CLIENT-PRINCIPAL');
      if (!principalHeader) return { status: 401, jsonBody: { error: 'Unauthorized' } };
      const userId = JSON.parse(Buffer.from(principalHeader, 'base64').toString('utf8')).userId;

      const body = await request.json();
      const { filmId, title, posterPath, action } = body; // action: 'add' or 'remove'

      const db = getCosmosDatabase();
      await db.containers.createIfNotExists({ id: 'watchlist', partitionKey: '/userId' });
      const container = db.container('watchlist');

      if (action === 'add') {
        await container.items.upsert({
          id: `${userId}_${filmId}`,
          userId,
          filmId: filmId.toString(),
          title,
          posterPath,
          addedAt: new Date().toISOString()
        });
      } else {
        try { await container.item(`${userId}_${filmId}`, userId).delete(); } catch (e) { }
      }
      return { status: 200, jsonBody: { message: `Watchlist updated` } };
    } catch (err) {
      context.error('Watchlist toggle error:', err);
      return { status: 500, jsonBody: { error: 'Watchlist update failed' } };
    }
  }
});

// -----------------------------------------------------------------------------
// 9. getWatchlist (HTTP GET)
// -----------------------------------------------------------------------------
app.http('getWatchlist', {
  methods: ['GET'],
  authLevel: 'anonymous',
  handler: async (request, context) => {
    try {
      const principalHeader = request.headers.get('x-ms-client-principal') || request.headers.get('X-MS-CLIENT-PRINCIPAL');
      if (!principalHeader) return { status: 401, jsonBody: { error: 'Unauthorized' } };
      const userId = JSON.parse(Buffer.from(principalHeader, 'base64').toString('utf8')).userId;

      const db = getCosmosDatabase();
      try {
        await db.containers.createIfNotExists({ id: 'watchlist', partitionKey: '/userId' });
      } catch (e) { }

      const { resources } = await db.container('watchlist').items.query({
        query: 'SELECT * FROM c WHERE c.userId = @uid ORDER BY c.addedAt DESC',
        parameters: [{ name: '@uid', value: userId }]
      }).fetchAll();

      return { status: 200, headers: { 'Content-Type': 'application/json' }, jsonBody: resources };
    } catch (err) {
      context.error('Get watchlist error:', err);
      return { status: 500, jsonBody: { error: 'Failed to load watchlist' } };
    }
  }
});

// -----------------------------------------------------------------------------
// 10. getCalendarLogs (HTTP GET)
// -----------------------------------------------------------------------------
// -----------------------------------------------------------------------------
// 10. getCalendarLogs (HTTP GET) - Bulletproof Version
// -----------------------------------------------------------------------------
app.http('getCalendarLogs', {
  methods: ['GET'],
  authLevel: 'anonymous',
  handler: async (request, context) => {
    try {
      const monthPrefix = request.query.get('month'); // "YYYY-MM"
      if (!monthPrefix) return { status: 400, jsonBody: { error: 'Month prefix required' } };

      const principalHeader = request.headers.get('x-ms-client-principal') || request.headers.get('X-MS-CLIENT-PRINCIPAL');
      if (!principalHeader) return { status: 401, jsonBody: { error: 'Unauthorized' } };
      const userId = JSON.parse(Buffer.from(principalHeader, 'base64').toString('utf8')).userId;

      const db = getCosmosDatabase();

      let followingIds = [userId];
      try {
        const { resource: userProfile } = await db.container('users').item(userId, userId).read();
        if (userProfile && Array.isArray(userProfile.following)) followingIds.push(...userProfile.following);
      } catch (e) { }

      const allLogs = [];

      // Safely query each user individually to prevent cross-partition crashes
      for (const uid of followingIds) {
        try {
          const { resources } = await db.container('logs').items.query({
            query: `SELECT * FROM c WHERE c.userId = @uid AND STARTSWITH(c.loggedAt, @month)`,
            parameters: [{ name: '@uid', value: uid }, { name: '@month', value: monthPrefix }]
          }).fetchAll();
          allLogs.push(...resources);
        } catch (e) {
          context.error(`Failed to fetch calendar logs for ${uid}`, e);
        }
      }

      // Sort by date chronologically
      allLogs.sort((a, b) => new Date(a.loggedAt) - new Date(b.loggedAt));

      return { status: 200, headers: { 'Content-Type': 'application/json' }, jsonBody: allLogs };
    } catch (err) {
      context.error('Calendar error:', err);
      return { status: 500, jsonBody: { error: 'Failed to load calendar logs' } };
    }
  }
});

// -----------------------------------------------------------------------------
// 11. requestRecap (HTTP POST -> Pushes to Storage Queue)
// -----------------------------------------------------------------------------
const azFunc = require('@azure/functions');
const recapQueueOutput = azFunc.output.storageQueue({
  queueName: 'recap-requests',
  connection: 'AzureWebJobsStorage'
});

app.http('requestRecap', {
  methods: ['POST'],
  authLevel: 'anonymous',
  extraOutputs: [recapQueueOutput],
  handler: async (request, context) => {
    try {
      const principalHeader = request.headers.get('x-ms-client-principal') || request.headers.get('X-MS-CLIENT-PRINCIPAL');
      if (!principalHeader) return { status: 401, jsonBody: { error: 'Unauthorized' } };
      const userId = JSON.parse(Buffer.from(principalHeader, 'base64').toString('utf8')).userId;

      const body = await request.json();
      const month = body.month; // e.g., '2026-10'

      const db = getCosmosDatabase();
      await db.containers.createIfNotExists({ id: 'recaps', partitionKey: '/userId' });
      const container = db.container('recaps');

      // 1. Mark as pending in the database
      await container.items.upsert({ id: `${userId}_${month}`, userId, month, status: 'pending' });

      // 2. Drop the heavy lifting request onto the Azure Storage Queue
      context.extraOutputs.set(recapQueueOutput, { userId, month });

      return { status: 202, jsonBody: { message: 'Recap requested and queued.' } };
    } catch (err) {
      context.error(err);
      return { status: 500, jsonBody: { error: 'Failed to queue recap' } };
    }
  }
});

// -----------------------------------------------------------------------------
// 12. processRecapWorker (QUEUE TRIGGER -> Heavy Compute Offload)
// -----------------------------------------------------------------------------
app.storageQueue('processRecapWorker', {
  queueName: 'recap-requests',
  connection: 'AzureWebJobsStorage',
  handler: async (queueItem, context) => {
    const { userId, month } = queueItem;
    try {
      const db = getCosmosDatabase();
      const { resources: logs } = await db.container('logs').items.query({
        query: `SELECT * FROM c WHERE c.userId = @uid AND STARTSWITH(c.loggedAt, @month)`,
        parameters: [{ name: '@uid', value: userId }, { name: '@month', value: month }]
      }).fetchAll();

      const totalFilms = logs.length;
      let highestRatedFilm = "None";
      let maxRating = 0;
      let sum = 0, count = 0;

      logs.forEach(log => {
        if (log.rating) {
          sum += parseFloat(log.rating);
          count++;
          if (log.rating > maxRating) {
            maxRating = log.rating;
            highestRatedFilm = log.filmTitle;
          }
        }
      });

      const avgRating = count > 0 ? (sum / count).toFixed(1) : "0.0";

      const recapData = {
        id: `${userId}_${month}`,
        userId, month, status: 'complete',
        stats: { totalFilms, highestRatedFilm, maxRating, avgRating },
        generatedAt: new Date().toISOString()
      };

      await db.container('recaps').items.upsert(recapData);
    } catch (err) { }
  }
});

// -----------------------------------------------------------------------------
// 13. getRecap (HTTP GET -> Check Status)
// -----------------------------------------------------------------------------
app.http('getRecap', {
  methods: ['GET'],
  authLevel: 'anonymous',
  handler: async (request, context) => {
    try {
      const principalHeader = request.headers.get('x-ms-client-principal') || request.headers.get('X-MS-CLIENT-PRINCIPAL');
      if (!principalHeader) return { status: 401 };
      const userId = JSON.parse(Buffer.from(principalHeader, 'base64').toString('utf8')).userId;
      const month = request.query.get('month');

      const db = getCosmosDatabase();
      try {
        const { resource } = await db.container('recaps').item(`${userId}_${month}`, userId).read();
        return { status: 200, jsonBody: resource || { status: 'none' } };
      } catch (e) {
        return { status: 200, jsonBody: { status: 'none' } };
      }
    } catch (err) {
      return { status: 500, jsonBody: { error: 'Failed to fetch recap status' } };
    }
  }
});

// -----------------------------------------------------------------------------
// 14. getFilmDetails (HTTP GET) - TMDB Deep Fetch
// -----------------------------------------------------------------------------
app.http('getFilmDetails', {
  methods: ['GET'],
  authLevel: 'anonymous',
  handler: async (request, context) => {
    try {
      const filmId = request.query.get('id');
      if (!filmId) return { status: 400, jsonBody: { error: "Film ID required" } };

      const apiKey = process.env.TMDB_API_KEY;
      // FIX: Append Reviews to the TMDB fetch
      const url = `https://api.themoviedb.org/3/movie/${filmId}?api_key=${apiKey}&append_to_response=credits,reviews`;

      const response = await fetch(url);
      if (!response.ok) throw new Error("TMDB fetch failed");

      const data = await response.json();
      return { status: 200, headers: { 'Content-Type': 'application/json' }, jsonBody: data };
    } catch (err) {
      return { status: 500, jsonBody: { error: 'Failed to fetch film details' } };
    }
  }
});

// -----------------------------------------------------------------------------
// 15. getUserProfile (For Smart Follow & Custom Profiles)
// -----------------------------------------------------------------------------
app.http('getUserProfile', {
  methods: ['GET'],
  authLevel: 'anonymous',
  handler: async (request, context) => {
    try {
      const username = request.query.get('username');
      if (!username) return { status: 400, jsonBody: { error: 'Username required' } };

      const db = getCosmosDatabase();
      const { resources } = await db.container('users').items.query({
        // FIX: Make search case-insensitive so the Follow button always appears
        query: `SELECT * FROM c WHERE LOWER(c.username) = LOWER(@uname)`,
        parameters: [{ name: '@uname', value: username }]
      }).fetchAll();

      if (resources.length === 0) return { status: 404, jsonBody: { error: 'User not found' } };
      return { status: 200, jsonBody: resources[0] };
    } catch (err) {
      return { status: 500, jsonBody: { error: 'Failed to fetch profile' } };
    }
  }
});

// -----------------------------------------------------------------------------
// 16. deleteUserData (Nuke Data)
// -----------------------------------------------------------------------------
app.http('deleteUserData', {
  methods: ['DELETE'],
  authLevel: 'anonymous',
  handler: async (request, context) => {
    try {
      const principalHeader = request.headers.get('x-ms-client-principal') || request.headers.get('X-MS-CLIENT-PRINCIPAL');
      if (!principalHeader) return { status: 401 };
      const userId = JSON.parse(Buffer.from(principalHeader, 'base64').toString('utf8')).userId;

      const db = getCosmosDatabase();

      // Wipe Logs
      const { resources: logs } = await db.container('logs').items.query({
        query: `SELECT c.id FROM c WHERE c.userId = @uid`,
        parameters: [{ name: '@uid', value: userId }]
      }).fetchAll();
      for (const log of logs) { await db.container('logs').item(log.id, userId).delete().catch(() => null); }

      // Wipe Watchlist
      const { resources: watchlist } = await db.container('watchlist').items.query({
        query: `SELECT c.id FROM c WHERE c.userId = @uid`,
        parameters: [{ name: '@uid', value: userId }]
      }).fetchAll();
      for (const item of watchlist) { await db.container('watchlist').item(item.id, userId).delete().catch(() => null); }

      // Wipe Recap & User Profile
      await db.container('recaps').item(`${userId}_2026-10`, userId).delete().catch(() => null);
      await db.container('users').item(userId, userId).delete().catch(() => null);

      return { status: 200, jsonBody: { message: 'Data nuked.' } };
    } catch (err) {
      return { status: 500, jsonBody: { error: 'Nuke failed' } };
    }
  }
});

// -----------------------------------------------------------------------------
// 17. deleteLog (HTTP DELETE)
// -----------------------------------------------------------------------------
app.http('deleteLog', {
  methods: ['DELETE'],
  authLevel: 'anonymous',
  handler: async (request, context) => {
    try {
      const principalHeader = request.headers.get('x-ms-client-principal') || request.headers.get('X-MS-CLIENT-PRINCIPAL');
      if (!principalHeader) return { status: 401 };
      const userId = JSON.parse(Buffer.from(principalHeader, 'base64').toString('utf8')).userId;

      const body = await request.json();
      if (!body.logId) return { status: 400, jsonBody: { error: 'logId required' } };

      const db = getCosmosDatabase();
      // Deletes the specific log. Partition key is userId for security.
      await db.container('logs').item(body.logId, userId).delete();

      return { status: 200, jsonBody: { message: 'Log deleted successfully' } };
    } catch (err) {
      return { status: 500, jsonBody: { error: 'Delete failed' } };
    }
  }
});

// -----------------------------------------------------------------------------
// 18. getNetworkProfiles (HTTP POST)
// -----------------------------------------------------------------------------
app.http('getNetworkProfiles', {
  methods: ['POST'],
  authLevel: 'anonymous',
  handler: async (request, context) => {
    try {
      const body = await request.json();
      const ids = body.ids || [];
      if (ids.length === 0) return { status: 200, jsonBody: [] };

      const quotedIds = ids.map(id => `'${id}'`).join(',');
      const db = getCosmosDatabase();
      const { resources } = await db.container('users').items.query(`SELECT c.id, c.username FROM c WHERE c.id IN (${quotedIds})`).fetchAll();

      return { status: 200, jsonBody: resources };
    } catch (err) {
      return { status: 500, jsonBody: { error: 'Failed to fetch network profiles.' } };
    }
  }
}); 