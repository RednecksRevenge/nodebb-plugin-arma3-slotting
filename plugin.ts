import * as notifications from "./lib/db/notifications";
import {AnyCallback, noop} from "./lib/fn";
import * as unattendUser from "./lib/unattendUser";
import {eventRepository} from "./lib/db/event";
const logger = require('./lib/logger');
const meta = require("./plugin.json");

meta.nbbId = meta.id.replace(/nodebb-plugin-/, "");

export function setup(params, callback): void {
    const adminModule = require("./lib/admin");
    const api = require("./lib/api");
    const actions = require("./lib/actions").default;

    adminModule.init(params, meta, function () {
        api.setConfig(adminModule.getPluginSettings());
        api.init(params, callback);
    });

    actions(params, meta, noop);
}

export function catchAttendanceChange(params, callback?: AnyCallback): void {
    callback = callback || noop;
    if (params.probability >= 1) {
        return callback(null, null);
    }
    unattendUser.unattendUser(params.tid, params.uid).then(resultCount => {
        if (resultCount) {
            notifications.notifyAutoUnslotted(params.tid, params.uid, resultCount);
        }
        callback(null, null);
    }).catch(error => {
        callback(error, null)
    });
}

export function filterAttendanceSlotted(params, callback: (err: Error, userIds: number[])=> void): void {
    const tid = params.tid;

    eventRepository.getSlottedUserIds(tid).then(userIds => {
        params.userIds = userIds;
        callback(null, userIds);
    }).catch(error => {
        callback(error, [])
    });
}

export function handleHeaders(params, callback): void {
    callback(null, null);
}

export const admin = {
    menu(customHeader, callback: AnyCallback) {
        customHeader.plugins.push({
            icon: "fa-calendar",
            name: meta.name,
            route: "/plugins/" + meta.nbbId,
        });

        callback(null, customHeader);
    },
};
