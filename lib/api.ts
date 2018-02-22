"use strict";

import {RequestHandler, Response, Router} from "express";
import {INodebbRequest} from "../types/nodebb";

import * as _ from "underscore";
import * as slottedUsersApi from "./api/slotted-users";
import * as matchApi from "./api/match";
import * as shareApi from "./api/share";
import * as reservationApi from "./api/reservations";
import * as slotApi from "./api/slot";
import * as userApi from "./api/users";
import * as topicDb from "./db/topics";
import * as shareDb from "./db/share";
import * as userDb from "./db/users";
import * as logger from "./logger";

const canAttend = require("../../nodebb-plugin-attendance/lib/admin").canAttend;
const canSee = require("../../nodebb-plugin-attendance/lib/admin").canSee;

const prefixApiPath = function (path) {
    return "/api/arma3-slotting" + path;
};

let apiKey;
let allowedCategories = [];

const exceptionToErrorResponse = function (e) {
    return {
        message: e.message,
    };
};

const topicIsEvent = (title) => {
    return title.trim().match(/([0-9]{4}-[0-9]{2}-[0-9]{2})([^0-9a-z])/i);
};

const secondsToEvent = function (title) {
    const dateParts = title.trim().match(/([0-9]{4}-[0-9]{2}-[0-9]{2})( [0-9:+ ])?[^0-9a-z]/i);
    if (!dateParts || !dateParts[0]) {
        return -1;
    }

    const eventDate = new Date(dateParts[0]);

    if (!dateParts[2]) {// if no time part was entered, assume next day
        eventDate.setTime(eventDate.getTime() + 86400 * 1000);
    }

    return (eventDate.getTime() - (new Date().getTime())) / 1000;
};

const requireEventInFuture = function (req: INodebbRequest, res: Response, next) {
    topicDb.getTitle(req.params.tid, function (err, title) {
        if (err) {
            return res.status(500).json(exceptionToErrorResponse(err));
        }
        if (!title) {
            return res
                .status(404)
                .json({message: "topic %d does not exist or doesnt have a title oO".replace("%d", req.params.tid)});
        }
        if (!topicIsEvent(title)) {
            return res
                .status(404)
                .json({message: "topic %d is no event".replace("%d", req.params.tid)});
        }
        if (secondsToEvent(title) < 0) {
            return res
                .status(403)
                .json({message: "too late. event start of %d is passed".replace("%d", req.params.tid)});
        }

        next();
    });
};

const requireTopic = function (req: INodebbRequest, res: Response, next) {
    topicDb.exists(req.params.tid, function (err, result) {
        if (err) {
            return res.status(500).json(exceptionToErrorResponse(err));
        }
        if (!result) {
            return res.status(404).json({message: "topic %d does not exist".replace("%d", req.params.tid)});
        }

        next();
    });
};

const methodNotAllowed = function (req: INodebbRequest, res: Response) {
    res.status(405).json({message: "Method not allowed"});
};

const restrictCategories = function (req: INodebbRequest, res: Response, next) {
    if (allowedCategories.length === 0) {
        next(); return;
    }

    topicDb.getCategoryId(req.params.tid, function (err, cid) {
        if (err) {
            return res.status(500).json(exceptionToErrorResponse(err));
        }
        if (allowedCategories.indexOf(cid) === -1) {
            return res.status(404).json({message: "API disabled for this category"});
        }

        next();
    });
};

const requireLoggedIn = function (req: INodebbRequest, res: Response, next) {
    if (apiKey && (req.header("X-Api-Key") === apiKey)) {
        next(); return;
    }
    if (req.uid) {
        next(); return;
    }
    return res.status(401).json({message: "plz log in to access this API"});
};

const requireCanSeeAttendance = function (req: INodebbRequest, res: Response, next) {
    canSee(req.uid, req.params.tid, function (err, result) {
        if (err) {
            throw err;
        }
        if (result) {
            next(); return;
        }
        return res.status(403).json({message: "you are not allowed to see this"});
    });
};

const requireCanWriteAttendance = function (req: INodebbRequest, res: Response, next) {
    if (req.header('X-Api-Key')) {
        shareDb.getFromDb(req.params.tid, req.params.matchid, req.header('X-Api-Key'), (err, result) => {
            if (result) {
                next();
                return;
            } else {
                return res.status(403).json({message: "Invalid share id"});
            }
        });
    } else {
        canAttend(req.uid, req.params.tid, function (err, result) {
            if (err) {
                throw err;
            }
            if (result) {
                next(); return;
            }
            return res.status(403).json({message: "you are not allowed to edit this"});
        });
    }
};

const requireAdminOrThreadOwner = function (req: INodebbRequest, res: Response, next) {
    const tid = parseInt(req.params.tid, 10);
    const uid = req.uid;

    if (apiKey && (req.header("X-Api-Key") === apiKey)) {
        next(); return;
    }

    if (!tid || !uid) {
        return res.status(400).json({message: "must be logged in and provide topic id"});
    }

    topicDb.isAllowedToEdit(req.uid, tid, function (err, result) {
        if (err) {
            return res.status(500).json(err);
        }
        if (!result) {
            logger.error("user " + req.uid + " tried to edit topic " + tid);
            return res.status(403).json({message: "You're not admin or owner of this topic"});
        }

        next();
    });
};

const isAdminOrThreadOwner = function (req: INodebbRequest, res) {
    const tid = parseInt(req.params.tid, 10);
    const uid = req.uid;
    const reqApiKey = req.header("X-Api-Key");

    if (reqApiKey) {
        return res.status(200).json({result: reqApiKey === apiKey});
    }

    if (!uid) {
        return res.status(200).json({result: false, message: "you're not logged in, btw"});
    }

    if (!tid) {
        return res.status(400).json({error: "must provide topic id"});
    }

    topicDb.isAllowedToEdit(req.uid, tid, function (err, hasAdminPermission) {
        if (err) {
            return res.status(500).json(err);
        }

        userDb.getGroups([req.uid], function (error, groups) {
            if (error) {
                return res.status(500).json(error);
            }
            return res.status(200).json({
                groups: groups[req.uid],
                result: hasAdminPermission,
            });
        });
    });
};

const returnSuccess: RequestHandler = function (req: INodebbRequest, res: Response) {
    res.status(200).json({});
};

const getApiMethodGenerator = function (router: Router, methodName: string) {
    return function (path: string, cb1?: RequestHandler, cb2?: RequestHandler, cb3?: RequestHandler) {
        const cbs: RequestHandler[] = Array.prototype.slice.call(arguments, 1);
        cbs.forEach(function (cb) {
            router[methodName](prefixApiPath(path), cb);
        });
    };
};

export function init(params, callback) {
    const routedMethodGenerator = _.partial(getApiMethodGenerator, params.router);
    const get = routedMethodGenerator("get");
    const pos = routedMethodGenerator("post");
    const del = routedMethodGenerator("delete");
    const put = routedMethodGenerator("put");
    const all = routedMethodGenerator("all");

    all("/:tid", requireTopic, restrictCategories);
    all("/:tid/*", requireTopic, restrictCategories);
    pos("/:tid/*", requireLoggedIn, restrictCategories, requireEventInFuture);
    put("/:tid/*", requireLoggedIn, restrictCategories, requireEventInFuture);
    del("/:tid/*", requireLoggedIn, restrictCategories, requireEventInFuture);

    get("/:tid", requireCanSeeAttendance, matchApi.getAll);

    get("/:tid/slotted-user-ids", requireCanSeeAttendance, slottedUsersApi.get);
    get("/:tid/has-permissions", isAdminOrThreadOwner, returnSuccess);

    pos("/:tid/match", requireAdminOrThreadOwner, matchApi.post);
    all("/:tid/match", methodNotAllowed);

    put("/:tid/match/:matchid", requireAdminOrThreadOwner, matchApi.put);
    get("/:tid/match/:matchid", requireCanSeeAttendance, matchApi.get);
    del("/:tid/match/:matchid", requireAdminOrThreadOwner, matchApi.del);
    all("/:tid/match/:matchid", methodNotAllowed);

    get("/:tid/match/:matchid/share", requireAdminOrThreadOwner, shareApi.getAll);
    get("/:tid/match/:matchid/share/:shareid", requireTopic, shareApi.get);
    pos("/:tid/match/:matchid/share", requireAdminOrThreadOwner, shareApi.post);
    del("/:tid/match/:matchid/share", requireAdminOrThreadOwner, shareApi.del);
    all("/:tid/match/:matchid/share", methodNotAllowed);

    get("/:tid/match/:matchid/slot", requireCanSeeAttendance, slotApi.getAll);
    all("/:tid/match/:matchid/slot", methodNotAllowed);

    put("/:tid/match/:matchid/slot/:slotid/user", requireCanWriteAttendance, userApi.put); // security in action method!
    del("/:tid/match/:matchid/slot/:slotid/user", requireCanWriteAttendance, userApi.del); // security in action method!
    get("/:tid/match/:matchid/slot/:slotid/user", requireCanSeeAttendance, userApi.get);
    all("/:tid/match/:matchid/slot/:slotid/user", methodNotAllowed);

    put("/:tid/match/:matchid/slot/:slotid/reservation", requireAdminOrThreadOwner, reservationApi.put);
    del("/:tid/match/:matchid/slot/:slotid/reservation", requireAdminOrThreadOwner, reservationApi.del);
    get("/:tid/match/:matchid/slot/:slotid/reservation", requireCanSeeAttendance, reservationApi.get);
    all("/:tid/match/:matchid/slot/:slotid/reservation", methodNotAllowed);

    callback();
}

export function setApiKey(newApiKey: string) {
    apiKey = newApiKey;
}

export function setAllowedCategories(newAllowedCategories) {
    allowedCategories = newAllowedCategories;
}
