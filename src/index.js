// Cloudflare Workers handler for post creation
import { connect } from '@planetscale/database';

const allowedOrigins = [
  'https://latestnewsandaffairs.site',
  'http://localhost:5173'
];

const setCorsHeaders = (request) => {
  const origin = request.headers.get('Origin');
  const headers = new Headers();
  
  if (allowedOrigins.includes(origin)) {
    headers.set('Access-Control-Allow-Origin', origin);
    headers.set('Vary', 'Origin');
  }
  headers.set('Access-Control-Allow-Methods', 'POST,OPTIONS');
  headers.set('Access-Control-Allow-Headers', 'Content-Type,Authorization');
  headers.set('Access-Control-Allow-Credentials', 'true');
  
  return headers;
};

const sendNotifications = async (db, { username, postId, message, photo, tags, replyTo }) => {
  const tasks = [];

  // Followers notification
  tasks.push((async () => {
    try {
      const followers = await db.execute(
        `SELECT follower AS username
         FROM follows
         WHERE following = ? AND relationship_status IN ('none','accepted') AND follower != ?`,
        [username, username]
      );
      
      if (!followers.rows.length) return;
      
      const preview = message
        ? message.slice(0, 50) + (message.length > 50 ? '…' : '')
        : (photo ? 'shared a photo' : 'made a post');
      const notif = `${username} posted: ${preview}`;
      const meta = JSON.stringify({ postId, postType: photo ? 'photo' : 'text', preview });
      
      // Insert notifications for each follower
      const promises = followers.rows.map(({ username: u }) =>
        db.execute(
          `INSERT INTO notifications (recipient, sender, type, message, metadata) VALUES (?,?,?,?,?)`,
          [u, username, 'new_post', notif, meta]
        )
      );
      
      await Promise.allSettled(promises);
    } catch (error) {
      console.error('Error sending follower notifications:', error);
    }
  })());

  // Tag mentions notification
  if (tags?.length) {
    tasks.push((async () => {
      try {
        const uniqueTags = [...new Set(tags.filter(t => t !== username))];
        if (!uniqueTags.length) return;
        
        const placeholders = uniqueTags.map(() => '?').join(',');
        const validUsers = await db.execute(
          `SELECT username FROM users WHERE username IN (${placeholders})`,
          uniqueTags
        );
        
        if (!validUsers.rows.length) return;
        
        const preview = message ? message.slice(0, 30) + (message.length > 30 ? '…' : '') : 'a post';
        const notif = `${username} mentioned you in ${preview}`;
        const meta = JSON.stringify({ postId, mentionType: 'tag' });
        
        const promises = validUsers.rows.map(({ username: u }) =>
          db.execute(
            `INSERT INTO notifications (recipient, sender, type, message, metadata) VALUES (?,?,?,?,?)`,
            [u, username, 'tag_mention', notif, meta]
          )
        );
        
        await Promise.allSettled(promises);
      } catch (error) {
        console.error('Error sending tag notifications:', error);
      }
    })());
  }

  // Reply notification
  if (replyTo?.username && replyTo.username !== username) {
    tasks.push((async () => {
      try {
        const userExists = await db.execute(
          'SELECT 1 FROM users WHERE username = ? LIMIT 1', 
          [replyTo.username]
        );
        
        if (!userExists.rows.length) return;
        
        const preview = message ? message.slice(0, 40) + (message.length > 40 ? '…' : '') : 'replied to your post';
        const notif = `${username} replied: ${preview}`;
        const meta = JSON.stringify({ postId, replyType: 'post_reply' });
        
        await db.execute(
          `INSERT INTO notifications (recipient, sender, type, message, metadata) VALUES (?,?,?,?,?)`,
          [replyTo.username, username, 'post_reply', notif, meta]
        );
      } catch (error) {
        console.error('Error sending reply notification:', error);
      }
    })());
  }

  // Execute all notification tasks concurrently
  await Promise.allSettled(tasks);
};

export default {
  async fetch(request, env, ctx) {
    const headers = setCorsHeaders(request);
    
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 200, headers });
    }

    if (request.method !== 'POST') {
      return new Response(JSON.stringify({ message: 'Method Not Allowed' }), {
        status: 405,
        headers: { ...Object.fromEntries(headers), 'Content-Type': 'application/json' }
      });
    }

    try {
      const { message, username, sessionId, photo, tags, replyTo } = await request.json();
      
      // Input validation
      if (!username || !sessionId || (!message && !photo)) {
        return new Response(JSON.stringify({ 
          message: 'Invalid request: username, sessionId, and either message or photo required' 
        }), {
          status: 400,
          headers: { ...Object.fromEntries(headers), 'Content-Type': 'application/json' }
        });
      }

      // Create database connection
      const db = connect({
        host: env.DB_HOST || 'srv787.hstgr.io',
        username: env.DB_USER || 'u208245805_Crypto21',
        password: env.DB_PASSWORD || 'Crypto21@',
        database: env.DB_NAME || 'u208245805_Crypto21'
      });

      // Extract tags from message if not provided
      const extractedTags = tags || [...new Set((message?.match(/@(\w+)/g) || []).map(t => t.slice(1)))];

      // Handle reply data
      let replyToData = null;
      if (replyTo?.postId) {
        const replyResult = await db.execute(
          'SELECT _id, username, message, photo, timestamp FROM posts WHERE _id = ?',
          [replyTo.postId]
        );
        
        if (!replyResult.rows.length) {
          return new Response(JSON.stringify({ message: 'Reply post not found' }), {
            status: 400,
            headers: { ...Object.fromEntries(headers), 'Content-Type': 'application/json' }
          });
        }
        
        const replyPost = replyResult.rows[0];
        replyToData = {
          postId: replyPost._id,
          username: replyPost.username,
          message: replyPost.message,
          photo: replyPost.photo,
          timestamp: replyPost.timestamp
        };
      }

      // Insert the new post
      const insertResult = await db.execute(
        `INSERT INTO posts (message, timestamp, username, sessionId, likes, likedBy, photo, tags, replyTo, categories)
         VALUES (?, NOW(), ?, ?, 0, '[]', ?, ?, ?, NULL)`,
        [
          message || '',
          username,
          sessionId,
          photo || null,
          JSON.stringify(extractedTags),
          replyToData ? JSON.stringify(replyToData) : null
        ]
      );

      const postId = insertResult.insertId;

      // Prepare response object
      const newPost = {
        _id: postId,
        message: message || '',
        timestamp: new Date(),
        username,
        likes: 0,
        likedBy: [],
        photo: photo || null,
        profilePicture: null,
        tags: extractedTags,
        replyTo: replyToData,
        categories: null
      };

      // Send notifications asynchronously using ctx.waitUntil
      ctx.waitUntil(
        sendNotifications(db, {
          username,
          postId,
          message,
          photo,
          tags: extractedTags,
          replyTo: replyToData
        }).catch(error => {
          console.error('Error sending notifications:', error);
        })
      );

      // Return success response
      return new Response(JSON.stringify(newPost), {
        status: 201,
        headers: { ...Object.fromEntries(headers), 'Content-Type': 'application/json' }
      });

    } catch (error) {
      console.error('Post creation error:', error);
      return new Response(JSON.stringify({ message: 'Error saving post' }), {
        status: 500,
        headers: { ...Object.fromEntries(headers), 'Content-Type': 'application/json' }
      });
    }
  }
};