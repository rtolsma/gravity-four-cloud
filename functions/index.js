// Imports
const admin = require('firebase-admin')
const functions = require('firebase-functions')
const express = require('express')
const bodyParser = require('body-parser')
admin.initializeApp();

const app = express();
const db = admin.firestore();

const WAITING = 'waitingRoom' //'rooms/waiting'
const WAITING_STATUS = -1;
const PLAYING_STATUS = -2;
const OFFLINE_STATUS = -3;
const ELO_DIFF = 300


app.use(bodyParser.json());

const asyncMiddleware = fn =>
  (req, res, next) => {
    Promise.resolve(fn(req, res, next))
      .catch(next);
  };

app.get('/api/helloworld', (req, res) => {
  res.send('hello world')
})

// Query with user object, returns challenge object blank if no match yet
app.post('/api/match', async (req, res) => {
  const body = req.body;
  const userId = req.body.uid;
  const currUserDoc = await getUserDoc(userId);
  const currUser = currUserDoc.data();
  const waitingRoom = db.collection(WAITING);
  const me = await waitingRoom.where('id', '==', currUser.id).limit(1).get()

  // If we are in the waiting room, return current statuses...don't challenge new people
  if (me.docs.length === 1) {
    const matchedOpponent = me.docs[0].data().oppponent;
    if (matchedOpponent) {
      const otherPlayer = await getUserDoc(matchedOpponent);
      const challenge = createChallenge(otherPlayer, currUser);  //note, otherPlayer challenged us so is first parameter
      res.send({challenge: challenge});
      //Will change waiting room status after end game
    } else{
      res.send({challenge: challenge})
    }
    return;
  }

  // If first visit i.e not already in waiting room, then scan for other players
  const querySnapshot = await waitingRoom.where('elo', '<', currUser.elo + ELO_DIFF)
              .where('elo', '>', currUser.elo - ELO_DIFF)
              .orderBy('elo')
              .where('opponent', '==', WAITING_STATUS)
              .orderBy('created').limit(1) // WE ONLY WANT ONE OTHER PLAYER RN
              .get();

  console.log("Query Snaphsot", querySnapshot)
  // Other "playable" player exists
  if( querySnapshot.docs.length !== 0) {
      const otherPlayer = querySnapshot.docs[0].data();
      // SEND MESSAGE AND COMMUNICATE TO OTHER USER
      
      const challenge = createChallenge(currUser, otherPlayer);

      //Create waiting room status for challenger 
      // (need this for future match api requests while still playing game)
      await waitingRoom.doc(currUser.id).set({
        id: currUser.id,
        created: firebase.firestore.Timestamp.fromDate(new Date()),
        elo: currUser.elo,
        oppponent: otherPlayer.id,
        })
      
      await waitingRoom.doc(otherPlayer.id).set({oppponent: currUser.id});
      initiateGame(challenge);
      res.send({challenge});

    } else {
      // No "playable" players, so add ourselves to the waiting room
      console.log('Query Snaphshot empty')
      // ADD OURSELVES TO THE WAITING ROOM
      waitingRoom.doc(currUser.id).set({
        id: currUser.id,
        created: firebase.firestore.Timestamp.fromDate(new Date()),
        elo: currUser.elo,
        oppponent: WAITING_STATUS,
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

  console.log('initiateGame called, other user:', otherUser, 'curr user:', currUser)
  // Setup the Game Room and set player statuses
  db.doc(challenge.room).set({
    moves: []
  }).catch((err) => console.log('Error in initiating game room', err, challenge))

  await waitingRoom.doc(challenge.playerOne).set({opponent: PLAYING_STATUS})
  await waitingRoom.doc(challenge.playerTwo).set({opponent: PLAYING_STATUS})

}

// UTILITY FUNCTIONS
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


async function cleanUpGame(challenge) {
  console.log('End Game is called with challenge:', challenge)
  const room = challenge.room;
  const starts = challenge.starts;


  // When the game finishes kill the game room, and change the player statuses
  db.doc(room).delete().then(() => console.log('Closed room:', room))
              .catch((err) => console.log('Error in closing room', room, 'Error: ', err))
  const waitingRoom = db.collection(WAITING);
  await waitingRoom.doc(challenge.playerOne).set({opponent: OFFLINE_STATUS})
  await waitingRoom.doc(challenge.playerTwo).set({opponent: OFFLINE_STATUS})

}





// Expose Express Routes
exports.app = functions.https.onRequest(app);

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

    userListening.set({
        challenge: {},
    }).then(() => console.log('created userListening room'))
      .catch((err) => console.log('Error in creating userListening room', err));
    return;
})

exports.deleteUser = functions.auth.user().onDelete( (user) => {

    console.log(user.displayName)
    const userDoc = admin.firestore().doc(`users/${user.uid}`);
    const userListening = admin.firestore().doc(`listening/${user.uid}`);
    userDoc.delete().then(() => console.log('succesfully deleted userdoc'))
            .catch((err) => console.log('Error in deleting userDoc', err));

    userListening.delete().then( () => console.log('successfully deleted userListening room'))
                 .catch((err) => console.log('Error in deleting userListening room', err));
    return;
})