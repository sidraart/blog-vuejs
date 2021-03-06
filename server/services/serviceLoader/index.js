"use strict";

let logger = require("../../core/logger");
let config = require("../../config");

let EventEmitter = require("events").EventEmitter;
let path = require("path");
let fs = require("fs");
let util = require("util");
let _ = require("lodash");
let chalk = require("chalk");
let express = require("express");

let C = require("../../core/constants");
let Context = require("../../core/context");
let auth = require("../../core/auth/helper");
let response = require("../../core/response");

let listEndpoints = require("express-list-endpoints");
let Table = require("cli-table2");

let GraphQLScalarType = require("graphql").GraphQLScalarType;
let Kind = require("graphql/language").Kind;

let EntityService = require("./entityService");

let routeRegister = require("./routeRegister");

/* global WEBPACK_BUNDLE */
if (!WEBPACK_BUNDLE) require("require-webpack-compat")(module, require);

/**
 * Service handler class
 */
class ServiceLoader extends EventEmitter {
  /**
	 * Constructor of ServiceLoader
	 */
  constructor() {
    super();
    this.setMaxListeners(0); // turn off

    this.app = null;
    this.db = null;
    this.services = {};
  }

  /**
	 * Load built-in and applogic services. Scan the folders
	 * and load service files
	 *
	 * @param  {Object} app ExpressJS instance
	 * @param  {Object} db  Database instance
	 */
  loadServices(app, db) {
    let self = this;
    self.app = app;
    self.db = db;

    let addEntityService = function(serviceSchema) {
      let service = new EntityService(serviceSchema, app, db);
      self.services[service.name] = service;
    };

    this.loadEmbeddedServices(addEntityService);
    this.loadBusinessServices(addEntityService);

    this.initialisationServices();
  }

  /**
   * Load the business services from the applogic folder.
   * @param {*} addEntityService
   */
  loadBusinessServices(addEntityService) {
    logger.debug(
      chalk.bold("Loading business services from... ") +
        path.join(__dirname, "..", "..", "applogic", "modules")
    );
    if (
      WEBPACK_BUNDLE ||
      fs.existsSync(path.join(__dirname, "..", "..", "applogic", "modules"))
    ) {
      logger.info("");
      logger.info(chalk.bold("Search Business Services..."));

      let modules = require.context(
        "../../applogic/modules",
        true,
        /service\.js$/
      );
      if (modules) {
        modules.keys().map(function(module) {
          logger.info(
            "  Load Business ",
            path.relative(
              path.join(__dirname, "..", "..", "applogic", "modules"),
              module
            ),
            "service..."
          );
          addEntityService(modules(module));
        });
      }
    }
  }

  /**
   * Load the embedded services using a callback to perform the addition.
   * @param {*} addEntityService the callback to add service.
   */
  loadEmbeddedServices(addEntityService) {
    const embeddedServiceFolder = path.join(
      __dirname,
      "..",
      "..",
      "services",
      "mailing1"
    );
    logger.debug(
      chalk.bold("Loading embedded services from... ") + embeddedServiceFolder
    );
    // Loading embedded server services
    if (WEBPACK_BUNDLE || fs.existsSync(embeddedServiceFolder)) {
      logger.info("");
      logger.info(chalk.bold("Search built-in services..."));

      let modules = require.context("../../services/mailing1", true, /\.js$/);
      if (modules) {
        modules.keys().map(function(module) {
          logger.info(
            "  Load",
            path.relative(embeddedServiceFolder, module),
            "service..."
          );
          addEntityService(modules(module));
        });
      }
    }
  }

  /**
   * Initialize the services.
   */
  initialisationServices() {
    let self = this;
    // Call `init` of services
    _.forIn(self.services, service => {
      if (_.isFunction(service.$schema.init)) {
        service.$schema.init.call(
          service,
          Context.CreateToServiceInit(service)
        );
      }
    });
  }

  /**
	 * Register actions of services as REST routes
	 *
	 * @param  {Object} app ExpressJS instance
	 */
  registerRoutes(app) {
	  let self = this;
	  routeRegister.registerRoutes(self);
  }

  /**
	 * Register actions of services as socket.io event handlers
	 *
	 * @param  {Object} IO            Socket.IO object
	 * @param  {Object} socketHandler Socket handler instance
	 */
  registerSockets(IO, socketHandler) {
    let self = this;

    _.forIn(this.services, (service, name) => {
      if (service.ws !== false) {
        service.socket = service.socket || {};

        // get namespace IO
        let io;
        if (service.socket.nsp && service.socket.nsp !== "/") {
          io = socketHandler.addNameSpace(service.socket.nsp, service.role);
        } else io = IO;

        service.io = io;

        io.on("connection", function(socket) {
          if (_.isFunction(service.socket.afterConnection)) {
            service.socket.afterConnection.call(service, socket, io);
          }

          _.forIn(service.actions, (actionFunc, name) => {
            let action = actionFunc.settings;
            action.handler = actionFunc;

            if (!_.isFunction(action.handler))
              throw new Error(
                `Missing handler function in '${name}' action in '${service.name}' service!`
              );

            let cmd = "/" + service.namespace + "/" + action.name;

            let handler = (data, callback) => {
              let ctx = Context.CreateFromSocket(
                service,
                action,
                self.app,
                socket,
                data
              );
              logger.debug(
                `Request via WebSocket '${service.namespace}/${action.name}'`,
                ctx.params
              );
              console.time("SOCKET request");
              self.emit("request", ctx);
              let cacheKey = service.getCacheKey(action.name, ctx.params);

              Promise.resolve()
                // Resolve model if ID provided
                .then(() => {
                  return ctx.resolveModel();
                })
                // Check permission
                .then(() => {
                  return ctx.checkPermission();
                })
                // Call the action handler
                .then(() => {
                  return action.handler(ctx);
                })
                // Response the result
                .then(json => {
                  if (_.isFunction(callback)) {
                    callback(response.json(null, json));
                  }
                })
                // Response the error
                .catch(err => {
                  logger.error(err);
                  if (_.isFunction(callback)) {
                    callback(response.json(null, null, err));
                  }
                })
                .then(() => {
                  self.emit("response", ctx);
                  console.timeEnd("SOCKET request");
                });
            };

            socket.on(cmd, handler);

            if (service.version) {
              socket.on("/v" + service.version + cmd, handler);
            }
          });
        });
      }
    });
  }

  /**
	 * Get actions of services as GraphQL queries & mutations schema
	 */
  registerGraphQLSchema() {
    let self = this;

    let schemas = {
      queries: [],
      types: [],
      mutations: [],
      resolvers: []
    };

    _.forIn(this.services, (service, name) => {
      if (
        service.$settings.graphql !== false &&
        _.isObject(service.$schema.graphql)
      ) {
        let graphQL = service.$schema.graphql;
        graphQL.resolvers = graphQL.resolvers || {};

        let processResolvers = function(resolvers) {
          _.forIn(resolvers, (resolver, name) => {
            if (_.isString(resolver) && service.actions[resolver]) {
              let handler = (root, args, context) => {
                let actionFunc = service.actions[resolver];

                let action = actionFunc.settings;
                action.handler = actionFunc;

                if (!_.isFunction(action.handler))
                  throw new Error(
                    `Missing handler function in '${name}' action in '${service.name}' service!`
                  );

                let ctx = Context.CreateFromGraphQL(
                  service,
                  action,
                  root,
                  args,
                  context
                );
                logger.debug("Request via GraphQL", ctx.params, context.query);
                console.time("GRAPHQL request");
                self.emit("request", ctx);
                let cacheKey = service.getCacheKey(action.name, ctx.params);

                return (
                  Promise.resolve()
                    // Resolve model if ID provided
                    .then(() => {
                      return ctx.resolveModel();
                    })
                    // Check permission
                    .then(() => {
                      return ctx.checkPermission();
                    })
                    // Call the action handler
                    .then(() => {
                      return action.handler(ctx);
                    })
                    .catch(err => {
                      logger.error(err);
                      throw err;
                    })
                    .then(json => {
                      self.emit("response", ctx);
                      console.timeEnd("GRAPHQL request");
                      return json;
                    })
                );
              };

              resolvers[name] = handler;
            }
          });
        };

        if (graphQL.resolvers.Query) processResolvers(graphQL.resolvers.Query);

        if (graphQL.resolvers.Mutation)
          processResolvers(graphQL.resolvers.Mutation);

        schemas.queries.push(graphQL.query);
        schemas.types.push(graphQL.types);
        schemas.mutations.push(graphQL.mutation);
        schemas.resolvers.push(graphQL.resolvers);
      }
    });

    // Merge Type Definitons

    if (schemas.queries.length == 0) return null;

    let mergedSchema = `

			scalar Timestamp

			type Query {
				${schemas.queries.join("\n")}
			}

			${schemas.types.join("\n")}

			type Mutation {
				${schemas.mutations.join("\n")}
			}

			schema {
				query: Query
				mutation: Mutation
			}
		`;

    // Merge Resolvers

    let mergeModuleResolvers = function(baseResolvers) {
      schemas.resolvers.forEach(module => {
        baseResolvers = _.merge(baseResolvers, module);
      });

      return baseResolvers;
    };

    return {
      schema: [mergedSchema],
      resolvers: mergeModuleResolvers({
        Timestamp: {
          __parseValue(value) {
            return new Date(value); // value from the client
          },
          __serialize(value) {
            return value.getTime(); // value sent to the client
          },
          __parseLiteral(ast) {
            if (ast.kind === Kind.INT) return parseInt(ast.value, 10); // ast value is always in string format

            return null;
          }
        }
        /* This version is not working
					Copied from http://dev.apollodata.com/tools/graphql-tools/scalars.html
				*/
        /*
				Timestamp: new GraphQLScalarType({
					name: "Timestamp",
					description: "Timestamp scalar type",
					parseValue(value) {
						return new Date(value); // value from the client
					},
					serialize(value) {
						return value.getTime(); // value sent to the client
					},
					parseLiteral(ast) {
						if (ast.kind === Kind.INT) {
							return parseInt(ast.value, 10); // ast value is always in string format
						}
						return null;
					},
				}),*/
      })
    };
  }

  /**
	 * Get a service by name
	 * @param  {String} serviceName Name of service
	 * @return {Object}             Service instance
	 * @memberOf ServiceLoader
	 */
  get(serviceName) {
    return this.services[serviceName];
  }

  /**
	 * Print service info to the console (in dev mode)
	 *
	 * @memberOf ServiceLoader
	 */
  printServicesInfo() {
    let endPoints = listEndpoints(this.app);
    logger.debug("Endpoints are : ", endPoints);
  }
}

// Export instance of class
module.exports = new ServiceLoader();
