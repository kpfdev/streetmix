const config = require('config')
const uuid = require('uuid')
const Twitter = require('twitter')
const User = require('../../models/user.js')
const logger = require('../../../lib/logger.js')()

exports.post = function (req, res) {
  let loginToken = null

  let handleTwitterSignIn = function (twitterCredentials) {
    // TODO: Call Twitter API with OAuth access credentials to make sure they are valid

    let handleCreateUser = function (err, user) {
      if (err) {
        logger.error(err)
        res.status(500).send('Could not create user.')
        return
      }

      let userJson = { id: user.id, loginToken: loginToken }
      logger.info({ user: userJson }, 'New user created.')
      res.header('Location', config.restapi.baseuri + '/v1/users/' + user.id)
      res.status(201).send(userJson)
    } // END function - handleCreateUser

    let handleUpdateUser = function (err, user) {
      if (err) {
        logger.error(err)
        res.status(500).send('Could not update user.')
        return
      }

      let userJson = { id: user.id, loginToken: loginToken }
      logger.info({ user: userJson }, 'Existing user issued new login token.')

      res.header('Location', config.restapi.baseuri + '/v1/users/' + user.id)
      res.status(200).send(userJson)
    } // END function - handleUpdateUser

    let handleFindUser = function (err, user) {
      if (err) {
        logger.error(err)
        res.status(500).send('Error finding user with Twitter ID.')
        return
      }
      console.log(user)
      loginToken = uuid.v1()
      if (!user) {
        let u = new User({
          id: twitterCredentials.screenName,
          twitter_id: twitterCredentials.userId,
          twitter_credentials: {
            access_token_key: twitterCredentials.oauthAccessTokenKey,
            access_token_secret: twitterCredentials.oauthAccessTokenSecret
          },
          login_tokens: [ loginToken ]
        })
        u.save(handleCreateUser)
      } else {
        user.id = twitterCredentials.screenName
        user.twitter_id = twitterCredentials.userId
        user.twitter_credentials = {
          access_token_key: twitterCredentials.oauthAccessTokenKey,
          access_token_secret: twitterCredentials.oauthAccessTokenSecret
        }
        user.login_tokens.push(loginToken)
        user.save(handleUpdateUser)
      }
    } // END function - handleFindUser

    // Try to find user with twitter ID
    User.findOne({ twitter_id: twitterCredentials.userId }, handleFindUser)
  } // END function - handleTwitterSignIn

  let body
  try {
    body = req.body
  } catch (e) {
    res.status(400).send('Could not parse body as JSON.')
    return
  }

  if (body.hasOwnProperty('twitter')) {
    // TODO: Validation

    handleTwitterSignIn(body.twitter)
  } else {
    res.status(400).send('Unknown sign-in method used.')
  }
} // END function - exports.post

exports.get = function (req, res) {
  let handleFindUserById = function (err, user) {
    if (err) {
      logger.error(err)
      res.status(500).send('Error finding user.')
      return
    }

    if (!user) {
      res.status(404).send('User not found.')
      return
    }

    let twitterApiClient
    try {
      twitterApiClient = new Twitter({
        consumer_key: config.twitter.oauth_consumer_key,
        consumer_secret: config.twitter.oauth_consumer_secret,
        access_token_key: user.twitter_credentials.access_token_key,
        access_token_secret: user.twitter_credentials.access_token_secret
      })
    } catch (e) {
      logger.error('Could not initialize Twitter API client. Error:')
      logger.error(e)
    }

    let sendUserJson = function (twitterData) {
      let auth = (user.login_tokens.indexOf(req.loginToken) > 0)

      user.asJson({ auth: auth }, function (err, userJson) {
        if (err) {
          logger.error(err)
          res.status(500).send('Could not render user JSON.')
          return
        }

        if (twitterData) {
          userJson.profileImageUrl = twitterData.profile_image_url_https
        }

        res.status(200).send(userJson)
      })
    } // END function - sendUserJson

    let responseAlreadySent = false
    let handleFetchUserProfileFromTwitter = function (err, res) {
      if (err) {
        logger.error('Twitter API call users/show returned error.')
        logger.error(err)
      }

      if (responseAlreadySent) {
        logger.debug({ profile_image_url: res.profile_image_url }, 'Twitter API users/show call returned but response already sent!')
      } else {
        logger.debug({ profile_image_url: res.profile_image_url }, 'Twitter API users/show call returned. Sending response with Twitter data.')
        responseAlreadySent = true

        if (!res) {
          logger.error('Twitter API call users/show did not return any data.')
        }

        sendUserJson(res)
      }
    } // END function - handleFetchUserProfileFromTwitter

    if (twitterApiClient) {
      logger.debug('About to call Twitter API: /users/show.json?user_id=' + user.twitter_id)
      twitterApiClient.get('/users/show.json', { user_id: user.twitter_id }, handleFetchUserProfileFromTwitter)
      setTimeout(
        function () {
          if (!responseAlreadySent) {
            logger.debug('Timing out Twitter API call after %d milliseconds and sending partial response.', config.twitter.timeout_ms)
            responseAlreadySent = true
            sendUserJson()
          }
        },
        config.twitter.timeout_ms)
    } else {
      sendUserJson()
    }
  } // END function - handleFindUserById

  // Flag error if user ID is not provided
  if (!req.params.user_id) {
    res.status(400).send('Please provide user ID.')
    return
  }

  let userId = req.params.user_id

  let handleFindUserByLoginToken = function (err, user) {
    if (err) {
      logger.error(err)
      res.status(500).send('Error finding user.')
      return
    }

    if (!user) {
      res.status(401).send('User with that login token not found.')
      return
    }

    User.findOne({ id: userId }, handleFindUserById)
  } // END function - handleFindUserByLoginToken

  if (req.loginToken) {
    User.findOne({ login_tokens: { $in: [ req.loginToken ] } }, handleFindUserByLoginToken)
  } else {
    User.findOne({ id: userId }, handleFindUserById)
  }
} // END function - exports.get

exports.delete = function (req, res) {
  let handleSaveUser = function (err, user) {
    if (err) {
      logger.error(err)
      res.status(500).send('Could not sign-out user.')
      return
    }
    res.status(204).end()
  } // END function - handleSaveUser

  let handleFindUser = function (err, user) {
    if (err) {
      logger.error(err)
      res.status(500).send('Error finding user.')
      return
    }

    if (!user) {
      res.status(404).send('User not found.')
      return
    }

    let idx = user.login_tokens.indexOf(req.loginToken)
    if (idx === -1) {
      res.status(401).end()
      return
    }

    user.login_tokens.splice(idx, 1)
    user.save(handleSaveUser)
  } // END function - handleFindUser

  // Flag error if user ID is not provided
  if (!req.params.user_id) {
    res.status(400).send('Please provide user ID.')
    return
  }

  let userId = req.params.user_id
  User.findOne({ id: userId }, handleFindUser)
} // END function - exports.delete

exports.put = function (req, res) {
  let body
  try {
    body = req.body
  } catch (e) {
    res.status(400).send('Could not parse body as JSON.')
    return
  }

  let handleSaveUser = function (err, user) {
    if (err) {
      logger.error(err)
      res.status(500).send('Could not update user information.')
      return
    }
    res.status(204).end()
  } // END function - handleSaveUser

  let handleFindUser = function (err, user) {
    if (err) {
      logger.error(err)
      res.status(500).send('Error finding user.')
      return
    }

    if (!user) {
      res.status(404).send('User not found.')
      return
    }

    if (user.login_tokens.indexOf(req.loginToken) === -1) {
      res.status(401).end()
      return
    }

    user.data = body.data || user.data
    user.save(handleSaveUser)
  } // END function - handleFindUser

  // Flag error if user ID is not provided
  if (!req.params.user_id) {
    res.status(400).send('Please provide user ID.')
    return
  }

  let userId = req.params.user_id
  User.findOne({ id: userId }, handleFindUser)
} // END function - exports.put
