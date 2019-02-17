# Gravity Four Cloud

This repository contains the code related to the Firebase Cloud functions used for the Gravity Four App. In addition, there is code hosted on Google Cloud Functions for our Python based AI.

## Endpoints


## Notes: `challenge`

The `challenge` token contains information necessary for the server to maintain track of all of the ongoing games. The object structure is of the form 

```
{
    challenge: {
        playerOne: uid,
        playerTwo: uid,
        room: docpath
    }
}
```


### POST `/api/match`

Expects: `{uid: int}` in the JSON body. Will respond with a `challenge` token that contains important bookkeeping information for the server if the user is placed out of the Queue. If not immediately matched, `challenge` will be an empty object, and the user will be placed into the queue. Repeated requests will reflect any changes in the matching process. Throughout the game, a call to `/api/match` will return the relevant `challenge` token.


### POST `/api/play`

Expects: `{uid: str, move: int, challenge: token}`. If it is your turn, then this request will update the game state and add your move into the game history. It returns the current "game room" information, including elapsed time per player, game move history, and player identities. Here is an example

```
{
    "moves": [
        1
    ],
    "playerOneTime": 7.1499998569488525,
    "lastMoveTime": 1550407420.517,
    "playerOne": "yiEnS751yeXqp0KXoC9i0pxYiwI2",
    "playerTwoTime": 0,
    "playerTwo": "cYRYCgrQCpYCM0WhjcJptLVR1EG2"
}
```

### POST `/api/play/moves`

Expects: `{challenge: token}`. Often while playing the game, it can be inconvenient and redundant to persistently ping the `/api/play` endpoint to add your next turn and can introduce unwanted race conditions). This endpoint accepts a challenge token and returns a single object `{moves: [int]}` containing the current game history. You can validate this on the client side to determine when an opponent has moved and it is your turn to move.


### POST `/api/endGame`

Expects: `{uid: str, won: float, challenge: token}`, always returns `{success: "success"}`. Client side validation of the game logic will determine whether a given player wins or not. It is the client side responsibility to send a POST request to this endpoint to notify the server of the results, to update player statistics, and close unnecessary connections. Following this call, both clients will be removed from the queue and subsequent calls to `/api/match` will no longer retain the generated `challenge` token.