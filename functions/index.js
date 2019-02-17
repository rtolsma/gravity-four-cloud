// Imports
const admin = require('firebase-admin')
const functions = require('firebase-functions')
const express = require('express')
const bodyParser = require('body-parser')
//const cors = require('cors')({origin: false});

admin.initializeApp(functions.config().firebase);

const app = express();
const db = admin.firestore();

const WAITING = 'waitingRoom' //'rooms/waiting'
const WAITING_STATUS = -1;
const OFFLINE_STATUS = -3;
const ELO_DIFF = 300;
const ELO_FACTOR = 32; // what they use in chess apparently


// parse application/x-www-form-urlencoded
app.use(bodyParser.urlencoded({ extended: false }));
// parse application/json
app.use(bodyParser.json());
app.use(cors)
const asyncMiddleware = fn =>
  (req, res, next) => {
    Promise.resolve(fn(req, res, next))
      .catch(next);
  };

app.post('/api/helloworld/', (req, res) => {
  console.log("BODY:", JSON.stringify(req.body))
  res.send({'hello world': JSON.stringify(req.body.message), "test":"test"})
})

// Query with user object, returns challenge object blank if no match yet
app.post('/api/match/', async (req, res) => {
  const body = req.body;
  const userId = req.body.uid;
  const currUserDoc = await getUserDoc(userId);
  const currUser = currUserDoc.data();
  const waitingRoom = db.collection(WAITING);
  console.log('Called API/Match with UID:', req.body, req.body.uid, "and then user is :", currUser)
  const me = await waitingRoom.where('id', '==', currUser.id).limit(1).get()

  // If we are in the waiting room, return current statuses...don't challenge new people
  if (me.docs.length === 1) {
    const matchedOpponent = me.docs[0].data().opponent;
    console.log("MATCHED OPPONENT:", matchedOpponent)
    if (![WAITING_STATUS, OFFLINE_STATUS].includes(matchedOpponent)) {
      const otherPlayer = await getUserDoc(matchedOpponent);
      const challenge = createChallenge(otherPlayer, currUser);  //note, otherPlayer challenged us so is first parameter
      res.send(challenge);

    } else{
      await waitingRoom.doc(currUser.id).set({
        id: currUser.id,
        created: admin.firestore.Timestamp.now(),
        elo: currUser.elo,
        opponent: WAITING_STATUS
      })
      res.send({challenge: {}})
    }
    return; // FUCK need to delete from waiting room after game
  }

  // If first visit i.e not already in waiting room, then scan for other players
  const querySnapshot = await waitingRoom.where('elo', '<', currUser.elo + ELO_DIFF)
              .where('elo', '>', currUser.elo - ELO_DIFF)
              .orderBy('elo')
              .where('opponent', '==', WAITING_STATUS)
              .orderBy('created')//.limit(1) // WE ONLY WANT ONE OTHER PLAYER RN
              .get();

  console.log("Query Snaphsot", querySnapshot.docs, querySnapshot.empty)
  // Other "playable" player exists
  if( querySnapshot.docs.length !== 0) {
      const otherPlayer = querySnapshot.docs[0].data();
      // SEND MESSAGE AND COMMUNICATE TO OTHER USER
      
      const challenge = createChallenge(currUser, otherPlayer);

      //Create waiting room OPPONENT for challenger 
      // (need this for future match api requests while still playing game)
      await waitingRoom.doc(currUser.id).set({
        id: currUser.id,
        created: admin.firestore.Timestamp.now(),
        elo: currUser.elo,
        opponent: otherPlayer.id,
        })
      // UPDATE OPPONENT STATUS FOR OTHER PLAYER
      await waitingRoom.doc(otherPlayer.id).update({opponent: currUser.id});
      initiateGame(challenge);
      res.send({challenge});

    } else {

      // No "playable" players, so add ourselves to the waiting room
      console.log('Query Snaphshot empty')
      // ADD OURSELVES TO THE WAITING ROOM
      waitingRoom.doc(currUser.id).set({
        id: currUser.id,
        created: admin.firestore.Timestamp.now(),
        elo: currUser.elo,
        opponent: WAITING_STATUS,
        }).then(function(docRef) {
          //RESPOND TO REST THAT WE"RE WAITING
          res.send({challenge: {}});
          console.log("Document written with ID: ", currUser.id);
        })
        .catch(function(error) {
          res.status(500);
          console.error("Error adding document: ", error);
        });
    }
})


// FIREBASE SETUP FUNCTIONS

async function initiateGame(challenge) {

  console.log('initiateGame called, challenge', challenge)
  // Setup the Game Room and set player statuses
  db.doc(challenge.room).set({
    moves: [],
    playerOne: challenge.playerOne,
    playerTwo: challenge.playerTwo,
    playerOneTime: 0,
    playerTwoTime: 0,
    lastMoveTime: new Date().getTime()/1000,
  }).catch((err) => console.log('Error in initiating game room', err, challenge))
  
}


// INFO NEEDED: Room ID, player UID
app.post('/api/play', async (req,res) => {

  const challenge = req.body.challenge;
  const playerOne = challenge.playerOne;
  const move = req.body.move;
  const playerId = req.body.uid;

  const gameRoom = (await db.doc(challenge.room).get()).data();
  const playerParity = (playerId == playerOne) ? 0 : 1;

  // It's our turn
  if (playerParity == gameRoom.moves.length % 2) {
    
    gameRoom.moves.push(move);
    const currTime = new Date().getTime() / 1000
    const timeSpent = (currTime - gameRoom.lastMoveTime)
    if(playerParity == 0) {
      gameRoom.playerOneTime += timeSpent;
    } else {
      gameRoom.playerTwoTime += timeSpent;
    }

    await db.doc(challenge.room).update({
      lastMoveTime: currTime,
      moves: gameRoom.moves,
      playerOneTime: gameRoom.playerOneTime,
      playerTwoTime: gameRoom.playerTwoTime,
      })

  }

  res.send((await db.doc(challenge.room).get()).data());

});

app.post('/api/play/moves', async (req, res) => {

  const challenge = req.body.challenge;
  const gameRoom = (await db.docs(challenge.room).get()).data();
  res.send({moves: gameRoom.moves})
})


//Requires: challenge, uid, won--binary corresponding to if client won
app.post('/api/endGame', async (req, res) => {

  // 1) Change waiting room stats to offline
  // 2) Update users/UID docs with new Elo+wins+gameHistory+totalGames
  // 3) Delete gameRoom --
  // to make sure loser doesn't call also (will only delete on user with last unchanged waiting status)
  res.send({success: "success"});


  const challenge = req.body.challenge;
  const playerId = req.body.uid;
  
  const room = (await db.doc(challenge.room).get()).data();

  const playerWaiting = (await db.collection(WAITING).doc(playerId).get()).data();
  const otherPlayerId = playerWaiting.opponent;

  //STATUS ALREADY CHANGED SO DON'T DO ANYTHING NEW
  if([WAITING_STATUS, OFFLINE_STATUS].includes(otherPlayerId)) {
    return;
  }
  
  const player = (await getUserDoc(playerId)).data();
  const otherPlayerWaiting = (await db.collection(WAITING).doc(otherPlayerId).get()).data();
  const otherPlayer = (await getUserDoc(playerId)).data()

  const won = req.body.won; //0 or 1 or 1/2


  player.totalGames += 1;
  player.gamesWon += won;
  player.gameHistory.push(room); // phat push

  if(otherPlayerWaiting.opponent !== playerId) {
    // Other player has already called this endpoint, time to shut the gameroom off
    // adjust both elos together
    const elos = calculateEloChange(player.elo, otherPlayer.elo, won);
    player.elo = elos['first'];
    otherPlayer.elo = elos['second']
    
    // Update opponents ELO
    db.doc(`users/${otherPlayerId}`).update({elo: otherPlayer.elo}).catch((err) => console.log('Error in updating elos'));


    db.doc(challenge.room).delete().catch((err) =>console.log('Error in Deleting the Game Room:', err))
  }

  // Set new stat changes
  db.doc(`users/${playerId}`).set(player).catch( (err) => console.log('Error updating user after game: ', err))


  // Now change waiting room status
  db.collection(WAITING).doc(playerId).update({opponent: OFFLINE_STATUS})
    .catch((err) => console.log('Error in updating waiting status after end game:', err))

});


// Requires: uid, username/displayName and friend userName/displayName
//Sends push notifications, assumes registrationToken is under users/uid
app.post('/api/challengeFriend', async (req, res) => {


  const playerId = req.body.uid;
  const friendUsername = req.body.friend;

  const querySnapshot = await db.doc('users').where('display', '==', friendUsername).get()
  if (querySnapshot.docs.length === 1) {
    const friend = querySnapshot.docs[0].data();
    const token = friend.registrationToken;



  } else {
    res.status(400).send({error: 'Username does not exist or is ambiguous?'})
  }

});


//########### UTILITY FUNCTIONS #####################

function calculateEloChange(first, second , won) {
  const r1 = Math.pow(10, (first)/400)
  const r2 = Math.pow(10, (second)/ 400)
  const e1 = r1/(r1+r2)
  const e2 = r2/(r1+r2)
  const newElo1 = r1 + ELO_FACTOR * (won - e1)
  const newElo2 = r2 + ELO_FACTOR * ( (1-won) - e2)
  return {first: newElo, second: newElo2}

}

function createChallenge(challenger, waiter) {
  const firstMove = Math.random() > 0.5 ? challenger.id : waiter.id;
  const secondMove = firstMove === challenger.id? waiter.id : challenger.id;
    const challenge = {
      room: `rooms/${challenger.id}${waiter.id}`,
      playerOne: firstMove,
      playerTwo: secondMove,
    }
    return challenge;
}

function getUserDoc(UID) {
  return db.doc(`users/${UID}`).get()
}


// Expose Express Routes
exports.app = functions.https.onRequest(app);

//#############################################################################


// Cloud Function Responses to event triggers
const DEFAULT_ELO = 1000;
exports.createUser = functions.auth.user().onCreate( (user) => {

    const email = user.email;
    const display = user.displayName;
    const id = user.uid;
    console.log(user)
    const userDoc = admin.firestore().doc(`users/${id}`);
    const userListening = admin.firestore().doc(`listening/${id}`);

    userDoc.set({
        id: id,
        display: display,
        elo: DEFAULT_ELO,
        gameHistory: [],
        friends: [],
        gamesWon: 0,
        totalGames: 0,
        
    }).then(() => console.log("created userDoc"))
      .catch((err) => console.log('Error in creating userDoc:', err));

    /*userListening.set({
        challenge: {},
    }).then(() => console.log('created userListening room'))
      .catch((err) => console.log('Error in creating userListening room', err));
    return; */
})

exports.deleteUser = functions.auth.user().onDelete( (user) => {

    console.log(user.displayName)
    const userDoc = admin.firestore().doc(`users/${user.uid}`);
    const userListening = admin.firestore().doc(`listening/${user.uid}`);
    userDoc.delete().then(() => console.log('succesfully deleted userdoc'))
            .catch((err) => console.log('Error in deleting userDoc', err));

    /*userListening.delete().then( () => console.log('successfully deleted userListening room'))
                 .catch((err) => console.log('Error in deleting userListening room', err));
    */
    return;
})