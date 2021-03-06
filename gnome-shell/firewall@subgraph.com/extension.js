const Lang = imports.lang;

const Main = imports.ui.main;

const Meta = imports.gi.Meta;
const Shell = imports.gi.Shell;

const Gio = imports.gi.Gio;
const GLib = imports.gi.GLib;

const Extension = imports.misc.extensionUtils.getCurrentExtension();
const Convenience = Extension.imports.convenience;

const Dialog = Extension.imports.dialog;
const Menu = Extension.imports.menu;
//const ConnectionMonitor = Extension.imports.cmonitor;

function init() {
    return new FirewallSupport();
}

const FirewallSupport = new Lang.Class({
    Name: 'FirewallSupport',

    _init: function() {
        this.menu = new Menu.FirewallMenu();
        //this.cmon = new ConnectionMonitor.ConnectionMonitor();
        this.handler = null;
    },

    _destroyHandler: function() {
        if (this.handler) {
            this.handler.destroy();
            this.handler = null;
        }
    },

    enable: function() {
        this._destroyHandler();
        this.handler = new FirewallPromptHandler();
        //this.cmon.install();
        this.menu.install();
    },

    disable: function() {
        this.menu.destroy();
        //this.cmon.remove();
        this._destroyHandler();
    }
});


// $ busctl --user call com.subgraph.FirewallPrompt /com/subgraph/FirewallPrompt com.subgraph.FirewallPrompt TestPrompt
const FirewallPromptInterface = '<node> \
<interface name="com.subgraph.FirewallPrompt"> \
    <method name="RequestPrompt"> \
        <arg type="s" direction="in" name="application" /> \
        <arg type="s" direction="in" name="icon" /> \
        <arg type="s" direction="in" name="path" /> \
        <arg type="s" direction="in" name="address" /> \
        <arg type="i" direction="in" name="port" /> \
        <arg type="s" direction="in" name="ip" /> \
        <arg type="s" direction="in" name="origin" /> \
        <arg type="s" direction="in" name="proto" /> \
        <arg type="i" direction="in" name="uid" /> \
        <arg type="i" direction="in" name="gid" /> \
        <arg type="s" direction="in" name="user" /> \
        <arg type="s" direction="in" name="group" /> \
        <arg type="i" direction="in" name="pid" /> \
        <arg type="s" direction="in" name="sandbox" /> \
        <arg type="b" direction="in" name="tlsguard" /> \
        <arg type="s" direction="in" name="optstring" /> \
        <arg type="b" direction="in" name="expanded" /> \
        <arg type="b" direction="in" name="expert" /> \
        <arg type="i" direction="in" name="action" /> \
        <arg type="i" direction="out" name="scope" /> \
        <arg type="s" direction="out" name="rule" /> \
    </method> \
    <method name="ClosePrompt"/> \
    <method name="TestPrompt"/> \
</interface> \
</node>';

const FirewallPromptHandler = new Lang.Class({
    Name: 'FirewallPromptHandler',

    _init: function() {
        this._settings = Convenience.getSettings();
        this._dbusImpl = Gio.DBusExportedObject.wrapJSObject(FirewallPromptInterface, this);
        this._dbusImpl.export(Gio.DBus.system, '/com/subgraph/FirewallPrompt');
        Gio.bus_own_name_on_connection(Gio.DBus.system, 'com.subgraph.FirewallPrompt', Gio.BusNameOwnerFlags.REPLACE, null, null);
        this._dialogs = new Array();
        this._dialog = null;
        this._promptTimeout = null;
        this._initKeybindings();
    },

    destroy: function() {
        log("SGFW: Exited");
        this._closeDialogs();
        this._dbusImpl.unexport();
        this._destroyKeybindings();
        if (this._promptTimeout !== null) {
            try {
                GLib.source_remove(this._promptTimeout);
            } catch (err) {
                //
            }
        }
    },

    _initKeybindings: function() {
        this._keyBindings = new Array(
            "prompt-scope-previous"
            , "prompt-scope-next"
            , "prompt-rule-next"
            , "prompt-rule-previous"
            , "prompt-rule-allow"
            , "prompt-rule-deny"
            , "prompt-toggle-details"
            , "prompt-toggle-tlsguard"
        );
        for (var i = 0 , ii = this._keyBindings.length; i < ii; i++) {
            Main.wm.addKeybinding(this._keyBindings[i],
                          this._settings,
                          Meta.KeyBindingFlags.NONE,
                          Shell.ActionMode.ALL,
                          Lang.bind(this, this._handleKeybinding, this._keyBindings[i]));
        }
    },

    _handleKeybinding: function(a, b, c, d, binding) {
        if (this._dialog === null || this._dialog === undefined) {
            return false;
        }

        let fname = binding.replace(/-([a-z])/g, function (g) { return g[1].toUpperCase(); });
        let fname = "_on"+ fname[0].toUpperCase() + fname.substr(1);
        if (!( fname in this._dialog )) {
            log("SGFW: Invalid key binding (1)... " + fname);
            return true;
        }
        let fn = this._dialog[fname];
        if (typeof fn !== "function") {
            log("SGFW: Invalid key binding (2)... " + fname + " " + (typeof fn));
            return true;
        }

        Lang.bind(this._dialog, fn)();
        return true;
    },

    _destroyKeybindings: function() {
        for (var i = 0 , ii = this._keyBindings.length; i < ii; i++) {
            Main.wm.removeKeybinding(this._keyBindings[i]);
        }
    },

    _closeDialogs: function() {
        log("SGFW: Closing all dialogs");
        if (this._dialog !== null && this._dialog !== undefined) {
            this._dialog.close();
        }
        while (this._dialogs.length > 0) {
            this._dialogs.shift();
        }
    },

    RequestPromptAsync: function(params, invocation) {
        log("SGFW: Requesting new dialog prompt...");
        try {
            params.push(invocation)
            this._dialogs.push(params);
            if (this._dialog === null || this._dialog === undefined) {
                this._dialog = true;
                this._createDialog();
            }
        } catch (err) {
            log("SGFW: Error while requesting prompt: " + err);
        }
    },

    _createDialog: function() {
        log("SGFW: Creating next available dialog...");
        try {
            let params = this._dialogs.shift();
            let [app, icon, path, address, port, ip, origin, proto, uid, gid, user, group, pid, sandbox, tlsguard, optstring, expanded, expert, action, invocation] = params;

            this._dialog = new Dialog.PromptDialog(invocation, (pid >= 0), (sandbox != ""), tlsguard);
            this._dialog.update(app, icon, path, address, port, ip, origin, uid, gid, user, group, pid, proto, tlsguard, optstring, sandbox, expanded, expert, action);
            this._dialog.connect("closed", Lang.bind(this, this.onCloseDialog));
            let fcount = 0;
            this._promptTimeout = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 20, Lang.bind(this, function() {
                if (this._dialog.open()) {
                    this._promptTimeout = null;
                    return false;
                }
                if (fcount++ > 200) {
                    log("SGFW: Failed creating dialog, repeated pushModal failures!");
                    this._promptTimeout = null;
                    this.onCloseDialog();
                    return false;
                }
                return true;
            }));
        } catch (err) {
            log("SGFW: Error while creating prompt: " + err);
        }
    },

    onCloseDialog: function() {
        log("SGFW: Closed dialog");
        try {
            this._dialog.close();
            this._dialog.destroy();
        } catch (err) {
            log("SGFW: Error unable to close/destroy modal...");
        }
        this._dialog = null;
        if (this._dialogs.length > 0) {
            log("SGFW: Opening next dialogs (remaining: " + this._dialogs.length + ")");
            this._createDialog();
        }
    },

    CloseAsync: function(params, invocation) {
        log("SGFW: Close Async Requested");
        this._closeDialogs();
    },

    TestPrompt: function(params, invocation) {
        log("SGFW: Test Prompt Requested");
        this.RequestPromptAsync(["Firefox", "firefox", "/usr/bin/firefox-esr", "242.12.111.18", "443", "linux", "2342", "TCP", true, true], nil);
    }
});

