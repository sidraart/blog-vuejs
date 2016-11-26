"use strict";

let logger 		= require("../../../core/logger");
let config 		= require("../../../config");
let C 	 		= require("../../../core/constants");

let _ 			= require("lodash");

let Sockets		= require("../../../core/sockets");
let User 		= require("../users/models/user");

let userService;

module.exports = {
	settings: {
		name: "session",
		version: 1,
		namespace: "session",
		rest: true,
		ws: true,
		graphql: true,
		permission: C.PERM_LOGGEDIN,
		role: "user"
	},

	actions: {

		// return my User model
		me(ctx) {
			return Promise.resolve(ctx.user).then( (doc) => {
				return userService.toJSON(doc);
			});
		},

		// return all online users
		onlineUsers(ctx) {
			return Promise.resolve().then(() => {
				return userService.toJSON(_.map(Sockets.userSockets, (s) => s.request.user));
			});
		}
	},

	init(ctx) {
		userService = this.services("users");
	},

	graphql: {

		query: `
			me: User
			onlineUsers: [User]
		`,

		mutation: `
		`,

		resolvers: {
			Query: {
				me: "me",
				onlineUsers: "onlineUsers"
			}
		}
	}

};

/*
## GraphiQL test ##

# Get my account
query me {
  me {
    ...userFields
  }
}


# Get list of online users
query getOnlineUser {
  onlineUsers {
    ...userFields
  }
}


fragment userFields on User {
  code
  fullName
  email
  username
  roles
  verified
  avatar
  lastLogin
  locale
}

*/