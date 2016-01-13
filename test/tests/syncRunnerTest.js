"use strict";

describe("Zotero.Sync.Runner", function () {
	Components.utils.import("resource://zotero/config.js");
	
	var apiKey = Zotero.Utilities.randomString(24);
	var baseURL = "http://local.zotero/";
	var userLibraryID, publicationsLibraryID, runner, caller, server, stub, spy;
	
	var responses = {
		keyInfo: {
			fullAccess: {
				method: "GET",
				url: "keys/" + apiKey,
				status: 200,
				json: {
					key: apiKey,
					userID: 1,
					username: "Username",
					access: {
						user: {
							library: true,
							files: true,
							notes: true,
							write: true
						},
						groups: {
							all: {
								library: true,
								write: true
							}
						}
					}
				}
			}
		},
		userGroups: {
			groupVersions: {
				method: "GET",
				url: "users/1/groups?format=versions",
				json: {
					"1623562": 10,
					"2694172": 11
				}
			},
			groupVersionsEmpty: {
				method: "GET",
				url: "users/1/groups?format=versions",
				json: {}
			},
			groupVersionsOnlyMemberGroup: {
				method: "GET",
				url: "users/1/groups?format=versions",
				json: {
					"2694172": 11
				}
			}
		},
		groups: {
			ownerGroup: {
				method: "GET",
				url: "groups/1623562",
				json: {
					id: 1623562,
					version: 10,
					data: {
						id: 1623562,
						version: 10,
						name: "Group Name",
						description: "<p>Test group</p>",
						owner: 1,
						type: "Private",
						libraryEditing: "members",
						libraryReading: "all",
						fileEditing: "members",
						admins: [],
						members: []
					}
				}
			},
			memberGroup: {
				method: "GET",
				url: "groups/2694172",
				json: {
					id: 2694172,
					version: 11,
					data: {
						id: 2694172,
						version: 11,
						name: "Group Name 2",
						description: "<p>Test group</p>",
						owner: 123456,
						type: "Private",
						libraryEditing: "admins",
						libraryReading: "all",
						fileEditing: "admins",
						admins: [],
						members: [1]
					}
				}
			}
		}
	};
	
	//
	// Helper functions
	//
	var setup = Zotero.Promise.coroutine(function* (options = {}) {
		yield Zotero.DB.queryAsync("DELETE FROM settings WHERE setting='account'");
		yield Zotero.Users.init();
		
		var runner = new Zotero.Sync.Runner_Module({ baseURL, apiKey });
		
		Components.utils.import("resource://zotero/concurrentCaller.js");
		var caller = new ConcurrentCaller(1);
		caller.setLogger(msg => Zotero.debug(msg));
		caller.stopOnError = true;
		caller.onError = function (e) {
			Zotero.logError(e);
			if (options.onError) {
				options.onError(e);
			}
			if (e.fatal) {
				caller.stop();
				throw e;
			}
		};
		
		return { runner, caller };
	})
	
	function setResponse(response) {
		setHTTPResponse(server, baseURL, response, responses);
	}
	
	
	//
	// Tests
	//
	let win;
	before(function* () {
		userLibraryID = Zotero.Libraries.userLibraryID;
		publicationsLibraryID = Zotero.Libraries.publicationsLibraryID;
		win = yield loadBrowserWindow();
	})
	beforeEach(function* () {
		Zotero.HTTP.mock = sinon.FakeXMLHttpRequest;
		
		server = sinon.fakeServer.create();
		server.autoRespond = true;
		
		({ runner, caller } = yield setup());
		
		yield Zotero.Users.setCurrentUserID(1);
		yield Zotero.Users.setCurrentUsername("A");
	})
	afterEach(function () {
		if (stub) stub.restore();
		if (spy) spy.restore();
	})
	after(function () {
		Zotero.HTTP.mock = null;
		if (win) {
			win.close();
		}
	})
	
	describe("#checkAccess()", function () {
		it("should check key access", function* () {
			setResponse('keyInfo.fullAccess');
			var json = yield runner.checkAccess(runner.getAPIClient({ apiKey }));
			var compare = {};
			Object.assign(compare, responses.keyInfo.fullAccess.json);
			delete compare.key;
			assert.deepEqual(json, compare);
		})
	})
	
	describe("#checkLibraries()", function () {
		afterEach(function* () {
			var group = Zotero.Groups.get(responses.groups.ownerGroup.json.id);
			if (group) {
				yield group.eraseTx();
			}
			group = Zotero.Groups.get(responses.groups.memberGroup.json.id);
			if (group) {
				yield group.eraseTx();
			}
		})
		
		it("should check library access and versions without library list", function* () {
			// Create group with same id and version as groups response
			var groupData = responses.groups.ownerGroup;
			var group1 = yield createGroup({
				id: groupData.json.id,
				version: groupData.json.version
			});
			groupData = responses.groups.memberGroup;
			var group2 = yield createGroup({
				id: groupData.json.id,
				version: groupData.json.version
			});
			
			setResponse('userGroups.groupVersions');
			var libraries = yield runner.checkLibraries(
				runner.getAPIClient({ apiKey }), false, responses.keyInfo.fullAccess.json
			);
			assert.lengthOf(libraries, 4);
			assert.sameMembers(
				libraries,
				[userLibraryID, publicationsLibraryID, group1.libraryID, group2.libraryID]
			);
		})
		
		it("should check library access and versions with library list", function* () {
			// Create groups with same id and version as groups response
			var groupData = responses.groups.ownerGroup;
			var group1 = yield createGroup({
				id: groupData.json.id,
				version: groupData.json.version
			});
			groupData = responses.groups.memberGroup;
			var group2 = yield createGroup({
				id: groupData.json.id,
				version: groupData.json.version
			});
			
			setResponse('userGroups.groupVersions');
			var libraries = yield runner.checkLibraries(
				runner.getAPIClient({ apiKey }),
				false,
				responses.keyInfo.fullAccess.json,
				[userLibraryID]
			);
			assert.lengthOf(libraries, 1);
			assert.sameMembers(libraries, [userLibraryID]);
			
			var libraries = yield runner.checkLibraries(
				runner.getAPIClient({ apiKey }),
				false,
				responses.keyInfo.fullAccess.json,
				[userLibraryID, publicationsLibraryID]
			);
			assert.lengthOf(libraries, 2);
			assert.sameMembers(libraries, [userLibraryID, publicationsLibraryID]);
			
			var libraries = yield runner.checkLibraries(
				runner.getAPIClient({ apiKey }),
				false,
				responses.keyInfo.fullAccess.json,
				[group1.libraryID]
			);
			assert.lengthOf(libraries, 1);
			assert.sameMembers(libraries, [group1.libraryID]);
		})
		
		it("should update outdated group metadata", function* () {
			// Create groups with same id as groups response but earlier versions
			var groupData1 = responses.groups.ownerGroup;
			var group1 = yield createGroup({
				id: groupData1.json.id,
				version: groupData1.json.version - 1,
				editable: false
			});
			var groupData2 = responses.groups.memberGroup;
			var group2 = yield createGroup({
				id: groupData2.json.id,
				version: groupData2.json.version - 1,
				editable: true
			});
			
			setResponse('userGroups.groupVersions');
			setResponse('groups.ownerGroup');
			setResponse('groups.memberGroup');
			var libraries = yield runner.checkLibraries(
				runner.getAPIClient({ apiKey }), false, responses.keyInfo.fullAccess.json
			);
			assert.lengthOf(libraries, 4);
			assert.sameMembers(
				libraries,
				[userLibraryID, publicationsLibraryID, group1.libraryID, group2.libraryID]
			);
			
			assert.equal(group1.name, groupData1.json.data.name);
			assert.equal(group1.version, groupData1.json.version);
			assert.isTrue(group1.editable);
			assert.equal(group2.name, groupData2.json.data.name);
			assert.equal(group2.version, groupData2.json.version);
			assert.isFalse(group2.editable);
		})
		
		it("should update outdated group metadata for group created with classic sync", function* () {
			var groupData1 = responses.groups.ownerGroup;
			var group1 = yield createGroup({
				id: groupData1.json.id,
				version: 0,
				editable: false
			});
			var groupData2 = responses.groups.memberGroup;
			var group2 = yield createGroup({
				id: groupData2.json.id,
				version: 0,
				editable: true
			});
			
			yield Zotero.DB.queryAsync(
				"UPDATE groups SET version=0 WHERE groupID IN (?, ?)", [group1.id, group2.id]
			);
			yield Zotero.Libraries.init();
			group1 = Zotero.Groups.get(group1.id);
			group2 = Zotero.Groups.get(group2.id);
			
			setResponse('userGroups.groupVersions');
			setResponse('groups.ownerGroup');
			setResponse('groups.memberGroup');
			var libraries = yield runner.checkLibraries(
				runner.getAPIClient({ apiKey }),
				false,
				responses.keyInfo.fullAccess.json,
				[group1.libraryID, group2.libraryID]
			);
			assert.lengthOf(libraries, 2);
			assert.sameMembers(libraries, [group1.libraryID, group2.libraryID]);
			
			assert.equal(group1.name, groupData1.json.data.name);
			assert.equal(group1.version, groupData1.json.version);
			assert.isTrue(group1.editable);
			assert.equal(group2.name, groupData2.json.data.name);
			assert.equal(group2.version, groupData2.json.version);
			assert.isFalse(group2.editable);
		})
		
		it("should create locally missing groups", function* () {
			setResponse('userGroups.groupVersions');
			setResponse('groups.ownerGroup');
			setResponse('groups.memberGroup');
			var libraries = yield runner.checkLibraries(
				runner.getAPIClient({ apiKey }), false, responses.keyInfo.fullAccess.json
			);
			assert.lengthOf(libraries, 4);
			var groupData1 = responses.groups.ownerGroup;
			var group1 = Zotero.Groups.get(groupData1.json.id);
			var groupData2 = responses.groups.memberGroup;
			var group2 = Zotero.Groups.get(groupData2.json.id);
			assert.ok(group1);
			assert.ok(group2);
			assert.sameMembers(
				libraries,
				[userLibraryID, publicationsLibraryID, group1.libraryID, group2.libraryID]
			);
			assert.equal(group1.name, groupData1.json.data.name);
			assert.isTrue(group1.editable);
			assert.equal(group2.name, groupData2.json.data.name);
			assert.isFalse(group2.editable);
		})
		
		it("should delete remotely missing groups", function* () {
			var groupData1 = responses.groups.ownerGroup;
			var group1 = yield createGroup({ id: groupData1.json.id, version: groupData1.json.version });
			var groupData2 = responses.groups.memberGroup;
			var group2 = yield createGroup({ id: groupData2.json.id, version: groupData2.json.version });
			
			setResponse('userGroups.groupVersionsOnlyMemberGroup');
			waitForDialog(function (dialog) {
				var text = dialog.document.documentElement.textContent;
				assert.include(text, group1.name);
			});
			var libraries = yield runner.checkLibraries(
				runner.getAPIClient({ apiKey }), false, responses.keyInfo.fullAccess.json
			);
			assert.lengthOf(libraries, 3);
			assert.sameMembers(libraries, [userLibraryID, publicationsLibraryID, group2.libraryID]);
			assert.isFalse(Zotero.Groups.exists(groupData1.json.id));
			assert.isTrue(Zotero.Groups.exists(groupData2.json.id));
		})
		
		it.skip("should keep remotely missing groups", function* () {
			var groupData = responses.groups.ownerGroup;
			var group = yield createGroup({ id: groupData.json.id, version: groupData.json.version });
			
			setResponse('userGroups.groupVersionsEmpty');
			waitForDialog(function (dialog) {
				var text = dialog.document.documentElement.textContent;
				assert.include(text, group.name);
			}, "extra1");
			var libraries = yield runner.checkLibraries(
				runner.getAPIClient({ apiKey }), false, responses.keyInfo.fullAccess.json
			);
			assert.lengthOf(libraries, 3);
			assert.sameMembers(libraries, [userLibraryID, publicationsLibraryID, group.libraryID]);
			assert.isTrue(Zotero.Groups.exists(groupData.json.id));
		})
		
		it("should cancel sync with remotely missing groups", function* () {
			var groupData = responses.groups.ownerGroup;
			var group = yield createGroup({ id: groupData.json.id, version: groupData.json.version });
			
			setResponse('userGroups.groupVersionsEmpty');
			waitForDialog(function (dialog) {
				var text = dialog.document.documentElement.textContent;
				assert.include(text, group.name);
			}, "cancel");
			var libraries = yield runner.checkLibraries(
				runner.getAPIClient({ apiKey }), false, responses.keyInfo.fullAccess.json
			);
			assert.lengthOf(libraries, 0);
			assert.isTrue(Zotero.Groups.exists(groupData.json.id));
		})
	})

	describe("#sync()", function () {
		before(function* () {
			yield resetDB({
				thisArg: this,
				skipBundledFiles: true
			});
			
			yield Zotero.Libraries.init();
		})
		
		it("should perform a sync across all libraries and update library versions", function* () {
			yield Zotero.Users.setCurrentUserID(1);
			yield Zotero.Users.setCurrentUsername("A");
			
			setResponse('keyInfo.fullAccess');
			setResponse('userGroups.groupVersions');
			setResponse('groups.ownerGroup');
			setResponse('groups.memberGroup');
			// My Library
			setResponse({
				method: "GET",
				url: "users/1/settings",
				status: 200,
				headers: {
					"Last-Modified-Version": 5
				},
				json: []
			});
			setResponse({
				method: "GET",
				url: "users/1/collections?format=versions",
				status: 200,
				headers: {
					"Last-Modified-Version": 5
				},
				json: []
			});
			setResponse({
				method: "GET",
				url: "users/1/searches?format=versions",
				status: 200,
				headers: {
					"Last-Modified-Version": 5
				},
				json: []
			});
			setResponse({
				method: "GET",
				url: "users/1/items?format=versions&includeTrashed=1",
				status: 200,
				headers: {
					"Last-Modified-Version": 5
				},
				json: []
			});
			setResponse({
				method: "GET",
				url: "users/1/deleted?since=0",
				status: 200,
				headers: {
					"Last-Modified-Version": 5
				},
				json: []
			});
			// My Publications
			setResponse({
				method: "GET",
				url: "users/1/publications/settings",
				status: 200,
				headers: {
					"Last-Modified-Version": 10
				},
				json: []
			});
			setResponse({
				method: "GET",
				url: "users/1/publications/items?format=versions&includeTrashed=1",
				status: 200,
				headers: {
					"Last-Modified-Version": 10
				},
				json: []
			});
			setResponse({
				method: "GET",
				url: "users/1/publications/deleted?since=0",
				status: 200,
				headers: {
					"Last-Modified-Version": 10
				},
				json: []
			});
			// Group library 1
			setResponse({
				method: "GET",
				url: "groups/1623562/settings",
				status: 200,
				headers: {
					"Last-Modified-Version": 15
				},
				json: []
			});
			setResponse({
				method: "GET",
				url: "groups/1623562/collections?format=versions",
				status: 200,
				headers: {
					"Last-Modified-Version": 15
				},
				json: []
			});
			setResponse({
				method: "GET",
				url: "groups/1623562/searches?format=versions",
				status: 200,
				headers: {
					"Last-Modified-Version": 15
				},
				json: []
			});
			setResponse({
				method: "GET",
				url: "groups/1623562/items?format=versions&includeTrashed=1",
				status: 200,
				headers: {
					"Last-Modified-Version": 15
				},
				json: []
			});
			setResponse({
				method: "GET",
				url: "groups/1623562/deleted?since=0",
				status: 200,
				headers: {
					"Last-Modified-Version": 15
				},
				json: []
			});
			// Group library 2
			setResponse({
				method: "GET",
				url: "groups/2694172/settings",
				status: 200,
				headers: {
					"Last-Modified-Version": 20
				},
				json: []
			});
			setResponse({
				method: "GET",
				url: "groups/2694172/collections?format=versions",
				status: 200,
				headers: {
					"Last-Modified-Version": 20
				},
				json: []
			});
			setResponse({
				method: "GET",
				url: "groups/2694172/searches?format=versions",
				status: 200,
				headers: {
					"Last-Modified-Version": 20
				},
				json: []
			});
			setResponse({
				method: "GET",
				url: "groups/2694172/items?format=versions&includeTrashed=1",
				status: 200,
				headers: {
					"Last-Modified-Version": 20
				},
				json: []
			});
			setResponse({
				method: "GET",
				url: "groups/2694172/deleted?since=0",
				status: 200,
				headers: {
					"Last-Modified-Version": 20
				},
				json: []
			});
			// Full-text syncing
			setResponse({
				method: "GET",
				url: "users/1/fulltext",
				status: 200,
				headers: {
					"Last-Modified-Version": 5
				},
				json: {}
			});
			setResponse({
				method: "GET",
				url: "users/1/publications/fulltext",
				status: 200,
				headers: {
					"Last-Modified-Version": 10
				},
				json: {}
			});
			setResponse({
				method: "GET",
				url: "groups/1623562/fulltext",
				status: 200,
				headers: {
					"Last-Modified-Version": 15
				},
				json: {}
			});
			setResponse({
				method: "GET",
				url: "groups/2694172/fulltext",
				status: 200,
				headers: {
					"Last-Modified-Version": 20
				},
				json: {}
			});
			
			yield runner.sync({
				onError: e => { throw e },
			});
			
			// Check local library versions
			assert.equal(
				Zotero.Libraries.getVersion(Zotero.Libraries.userLibraryID),
				5
			);
			assert.equal(
				Zotero.Libraries.getVersion(Zotero.Libraries.publicationsLibraryID),
				10
			);
			assert.equal(
				Zotero.Libraries.getVersion(Zotero.Groups.getLibraryIDFromGroupID(1623562)),
				15
			);
			assert.equal(
				Zotero.Libraries.getVersion(Zotero.Groups.getLibraryIDFromGroupID(2694172)),
				20
			);
			
			// Last sync time should be within the last second
			var lastSyncTime = Zotero.Sync.Data.Local.getLastSyncTime();
			assert.isAbove(lastSyncTime, new Date().getTime() - 1000);
			assert.isBelow(lastSyncTime, new Date().getTime());
		})
	})
	
	describe("#createAPIKeyFromCredentials()", function() {
		var data = {
			name: "Automatic Zotero Client Key",
			username: "Username",
			access: {
				user: {
					library: true,
					files: true,
					notes: true,
					write: true
				},
				groups: {
					all: {
						library: true,
						write: true
					}
				}
			}
		};
		var correctPostData = Object.assign({password: 'correctPassword'}, data);
		var incorrectPostData = Object.assign({password: 'incorrectPassword'}, data);
		var responseData = Object.assign({userID: 1, key: apiKey}, data);

		it("should return json with key when credentials valid", function* () {
			server.respond(function (req) {
				if (req.method == "POST") {
					var json = JSON.parse(req.requestBody);
					assert.deepEqual(json, correctPostData);
					req.respond(201, {}, JSON.stringify(responseData));
				}
			});

			var json = yield runner.createAPIKeyFromCredentials('Username', 'correctPassword');
			assert.equal(json.key, apiKey);
		});

		it("should return false when credentials invalid", function* () {
			server.respond(function (req) {
				if (req.method == "POST") {
					var json = JSON.parse(req.requestBody);
					assert.deepEqual(json, incorrectPostData);
					req.respond(403);
				}
			});

			var key = yield runner.createAPIKeyFromCredentials('Username', 'incorrectPassword');
			assert.isFalse(key);
		});
	});

	describe("#deleteAPIKey()", function() {
		it("should send DELETE request with correct key", function* (){
			Zotero.Sync.Data.Local.setAPIKey(apiKey);

			server.respond(function (req) {
				if (req.method == "DELETE") {
					assert.equal(req.url, baseURL + "keys/" + apiKey);
				}
				req.respond(204);
			});

			yield runner.deleteAPIKey();
		});
	})
})