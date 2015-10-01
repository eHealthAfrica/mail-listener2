var Imap = require('imap');
var util = require('util');
var EventEmitter = require('events').EventEmitter;
var MailParser = require("mailparser").MailParser;
var fs = require("fs");
var path = require('path');
var async = require('async');
var _ = require('underscore');


function MailListener (options) {
  this.markSeen = !! options.markSeen;
  this.mailbox = options.mailbox || "INBOX";
  if (typeof options.searchFilter === 'string') {
    this.searchFilter = [options.searchFilter];
  } else {
    this.searchFilter = options.searchFilter || ["UNSEEN"];
  }
  this.fetchUnreadOnStart = !!options.fetchUnreadOnStart;
  this.mailParserOptions = options.mailParserOptions || {};
  if (options.attachments && options.attachmentOptions && options.attachmentOptions.stream) {
    this.mailParserOptions.streamAttachments = true;
  }
  this.attachmentOptions = options.attachmentOptions || {};
  this.attachments = options.attachments || false;
  this.attachmentOptions.directory = (this.attachmentOptions.directory ? this.attachmentOptions.directory : '');

  this.imap = new Imap({
    xoauth2: options.xoauth2,
    user: options.username,
    password: options.password,
    host: options.host,
    port: options.port,
    tls: options.tls,
    keepAlive: false,
    //debug: function (info) {console.log(info)},
    tlsOptions: options.tlsOptions || {}
  });

  this.imap.once('ready', imapReady.bind(this));
  this.imap.once('close', imapClose.bind(this));
  this.imap.on('error',   imapError.bind(this));
}

util.inherits(MailListener, EventEmitter);

MailListener.prototype.start = function () {
  this.imap.connect();
};

MailListener.prototype.stop = function () {
  console.log("mail listener: stopping");
  var self = this;
  // setTimeout(function () {
    self.imap.end();
  // }, 5000);
};

function imapReady() {
  var self = this;
  this.imap.openBox(this.mailbox, false, function (err, mailbox) {
    if (err) {
      self.emit('error', err);
    } else {
      self.emit('server:connected');
      if (self.fetchUnreadOnStart) {
        parseUnread.call(self);
      }
      self.imap.on('mail', imapMail.bind(self));
    }
  });
}

function imapClose() {
  console.log("mail listener: server:disconnected");
  this.emit('server:disconnected');
}

function imapError(err) {
  this.emit('error', err);
}

function imapMail() {
  parseUnread.call(this);
}

function parseUnread() {
  var self = this;
  this.imap.search(self.searchFilter, function (err, results) {
    if (err) {
      self.emit('error', err);
    } else if (results.length > 0) {
      async.each(results, function (result, resultCallback) {
        var callback1 = _.after(2, resultCallback);
        var f = self.imap.fetch(result, {
          bodies: '',
          markSeen: self.markSeen
        });
        f.on('message', function (msg, seqno) {
          var parser = new MailParser(self.mailParserOptions);
          var attributes = null;
          parser.on("end", function (mail) {
            if (!self.mailParserOptions.streamAttachments && mail.attachments && self.attachments) {
              async.each(mail.attachments, function (attachment, callback2) {
                fs.writeFile( self.attachmentOptions.directory + attachment.generatedFileName, attachment.content, function (err) {
                  if (err) {
                    self.emit('error', err);
                  } else {
                    attachment.path = path.resolve(self.attachmentOptions.directory + attachment.generatedFileName);
                    self.emit('attachment', attachment);
                  }
                  callback2();
                });
              }, function (err) {
                self.emit('mail', mail, seqno, attributes);
                callback1();
              });
            } else {
              self.emit('mail', mail, seqno, attributes);
              callback1();
            }
          });

          parser.on("attachment", function (attachment, email) {
            self.emit('attachment', attachment, email);
          });
          msg.on('body', function (stream, info) {
            stream.pipe(parser);
          });
          msg.on('attributes', function (attrs) {
            attributes = attrs;
          });
        });

        f.once('error', function (err) {
          self.emit('error', err);
        });
        f.once('end', function (err) {
          callback1();
        });
      }, function (err) {
        if (err) {
          self.emit('error', err);
        }
          self.stop();
      });
    } else {
        self.stop();
    }
  });
}

module.exports = MailListener;
