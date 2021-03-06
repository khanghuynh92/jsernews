const {commentEditTime, commentReplyShift, deletedUser} = require('./config');
const {getNewsById} = require('./news');
const {getUserById} = require('./user');
const {hexdigest, numElapsed, strElapsed} = require('./utils');

class Comment {
  constructor (redis, namespace, sort=null){
    this.r = redis;
    this.namespace = namespace;
    this.sort = sort;
  }

  threadKey (thread_id){
    return `thread:${this.namespace}:${thread_id}`;
  }

  async fetch (thread_id, comment_id){
    let key = this.threadKey(thread_id);
    let json = await this.r.hget(key, comment_id);
    if (!json) return null;
    json = JSON.parse(json);
    json.thread_id = + thread_id;
    json.id = + comment_id;
    return json;
  }

  async insert(thread_id, comment) {
    if (!comment.hasOwnProperty('parent_id')) throw Error('no parent_id field');
    let key = this.threadKey(thread_id);
    if (comment.parent_id != -1) {
      let parent = await this.r.hget(key, comment.parent_id);
      if (!parent) return false;
    }
    let id = await this.r.hincrby(key, 'nextid', 1);
    await this.r.hset(key, id, JSON.stringify(comment));
    return + id;
  }

  async edit(thread_id, comment_id, updates) {
    let key = this.threadKey(thread_id);
    let old = await this.r.hget(key, comment_id);
    if (!old) return false;
    let comment = Object.assign(JSON.parse(old), updates);
    await this.r.hset(key, comment_id, JSON.stringify(comment));
    return true;
  }

  async removeThread(thread_id) {
    return await this.r.del(this.threadKey(thread_id));
  }

  async commentsInThread(thread_id) {
    return (parseInt(await this.r.hlen(this.threadKey(thread_id))) - 1);
  }

  async delComment(thread_id, comment_id) {
    return await this.edit(thread_id, comment_id, {del: 1});
  }

  async fetchThread(thread_id) {
    let byparent = {};
    let threads = await this.r.hgetall(this.threadKey(thread_id));
    for (let id in threads) {
      let comment = threads[id];
      if (id == 'nextid') continue;
      let c = JSON.parse(comment);
      c.id = + id;
      c.thread_id = + thread_id;
      let parent_id = + c.parent_id;
      if (!byparent.hasOwnProperty(parent_id)) byparent[parent_id] = [];
      byparent[parent_id].push(c);
    }
    return byparent;
  }

  async renderComments(thread_id, root = -1, block) {
    let byparent = await this.fetchThread(thread_id);
    if (byparent[-1]) await this.renderCommentsRec(byparent, root, 0, block);
  }

  async renderCommentsRec(byparent, parent_id, level, block) {
    let thislevel = byparent[parent_id];
    if (!thislevel) return '';
    if(this.sort) thislevel = this.sort.call(this, thislevel, level);
    for (let c of thislevel) {
      c.level = level;
      let parents = byparent[c.id];
      // Render the comment if not deleted, or if deleted but
      // has replies.
      if (!c.del || + c.del == 0 || parents) await block.call(this, c);
      if (parents)
        await this.renderCommentsRec(byparent, c.id, level+1, block);
    }
  }
}

// Compute the comment score
function computeCommentScore(c) {
  let upcount = c.up ? c.up.length : 0;
  let downcount = c.down ? c.down.length : 0;
  return upcount - downcount;
}

// Render a comment into HTML.
// 'c' is the comment representation as a Ruby hash.
// 'u' is the user, obtained from the user_id by the caller.
// 'show_parent' flag to show link to parent comment.
function commentToHtml (c, u, show_parent = false) {
  let indent = c.level ? `margin-left:${(+ c.level) * commentReplyShift}px` : '';
  let score = computeCommentScore(c);
  let news_id = c.thread_id;

  if (c.del && +c.del == 1)
    return $h.article({style: indent, class: 'commented deleted'}, 'comment deleted');

  let show_edit_link = !c.topcomment &&
      ($user && (+$user.id == +c.user_id)) &&
      (+c.ctime > (numElapsed() - commentEditTime));

  let comment_id = c.id ? `${news_id}-${c.id}` : '';
  return $h.article({class: 'comment', style: indent, 'data-comment-id': comment_id, id: comment_id}, () => {
    return $h.span({class: "avatar"}, () => {
      let email = u.email || "";
      let digest = hexdigest(email);
      return $h.img({src: `//gravatar.com/avatar/${digest}?s=48&d=mm`});
    }) + $h.span({class: 'info'}, () => {
      return $h.span({class: 'username'},
          $h.a({href: '/user/' + encodeURIComponent(u.username)}, $h.entities(u.username))
        ) + ' ' +
        strElapsed(+c.ctime) + '. ' +
        (!c.topcomment ? $h.a({href: `/comment/${news_id}/${c.id}`, class: 'reply'}, 'link ') : '') +
        (show_parent && c.parent_id > -1 ? $h.a({href: `/comment/${news_id}/${c.parent_id}`, class: 'reply'}, 'parent ') : '') +
        ($user && !c.topcomment ? $h.a({href: `/reply/${news_id}/${c.id}`, class: 'reply'}, 'reply ') : ' ') +
        (!c.topcomment ? (() => {
          let upclass = 'uparrow';
          let downclass = 'downarrow';
          if ($user && c.up && c.up.includes(+$user.id)) {
            upclass += ' voted';
            downclass += ' disabled';
          } else if ($user && c.down && c.down.includes(+$user.id)) {
            downclass += ' voted';
            upclass += ' disabled';
          }
          return `${score} point` + `${Math.abs(+score) > 1 ? 's' : ''}` + ' ' +
            $h.a({href: '#up', class: upclass}, '&#9650; ') +
            $h.a({href: '#down', class: downclass}, '&#9660; ');
        })() : ' ') +
        (show_edit_link ?
          $h.a({href: `/editcomment/${news_id}/${c.id}`, class: 'reply'}, 'edit') +
            ` (${
                parseInt((commentEditTime - (numElapsed() - parseInt(c.ctime))) / 60)
            } minutes left)`
        : "");
    }) + $h.pre(urlsToLinks($h.entities(c.body.trim())));
  });
}

// Get comments in chronological order for the specified user in the
// specified range.
async function getUserComments (user_id, start, count){
  let $r = global.comment.r;
  let numitems = + await $r.zcard(`user.comments:${user_id}`);
  let ids = await $r.zrevrange(`user.comments:${user_id}`, start, start + (count - 1));
  let comments = [];
  for (let id of ids) {
    let [news_id, comment_id] = id.split('-');
    let comment = await global.comment.fetch(news_id, comment_id);
    if (comment) comments.push(comment);
  }
  return [comments, numitems];
}

// This function has different behaviors, depending on the arguments:
//
// 1) If comment_id is -1 insert a new comment into the specified news.
// 2) If comment_id is an already existing comment in the context of the
//    specified news, updates the comment.
// 3) If comment_id is an already existing comment in the context of the
//    specified news, but the comment is an empty string, delete the comment.
//
// Return value:
//
// If news_id does not exist or comment_id is not -1 but neither a valid
// comment for that news, nil is returned.
// Otherwise an hash is returned with the following fields:
//   news_id: the news id
//   comment_id: the updated comment id, or the new comment id
//   op: the operation performed: "insert", "update", or "delete"
//
// More informations:
//
// The parent_id is only used for inserts (when comment_id == -1), otherwise
// is ignored.
async function insertComment(news_id, user_id, comment_id, parent_id, body){
  let p, $r = global.comment.r;
  let news = await getNewsById(news_id);
  if (!news) return false;
  if (comment_id == -1) {
    if (+parent_id != -1) {
      p = await global.comment.fetch(news_id, parent_id);
      if (!p) return false;
    }
    let comment = {
      score: 0,
      body: body,
      parent_id: parent_id,
      user_id: user_id,
      ctime: numElapsed(),
      up: [+user_id]
    }
    comment_id = await global.comment.insert(news_id, comment);
    if (!comment_id) return false;
    await $r.hincrby(`news:${news_id}`, 'comments', 1);
    await $r.zadd(`user.comments:${user_id}`,
      numElapsed(),
      news_id + "-" + comment_id);
    // increment_user_karma_by(user_id,KarmaIncrementComment)
    if (p && await $r.exists(`user:${p.user_id}`))
      await $r.hincrby(`user:${p.user_id}`, 'replies', 1);

    return {
      news_id: news_id,
      comment_id: comment_id,
      op: "insert"
    }
  }

  // If we reached this point the next step is either to update or
  // delete the comment. So we make sure the user_id of the request
  // matches the user_id of the comment.
  // We also make sure the user is in time for an edit operation.
  let c = await global.comment.fetch(news_id, comment_id);
  if (!c || +c.user_id != +user_id) return false;
  if (!(+c.ctime > (numElapsed() - commentEditTime))) return false;

  if (body.length == 0) {
    if (!await global.comment.delComment(news_id, comment_id)) return false;
    await $r.hincrby(`news:${news_id}`, 'comments', -1);
    return {
      news_id: news_id,
      comment_id: comment_id,
      op: "delete"
    };
  } else {
    let update = {body: body};
    if (+c.del == 1) update = {del: 0};
    if (!await global.comment.edit(news_id, comment_id, update)) return false;
    return {
      news_id: news_id,
      comment_id: comment_id,
      op: 'update'
    };
  }
}

async function voteComment(news_id, comment_id, user_id, vote_type) {
  let comment = await global.comment.fetch(news_id, comment_id);
  if (!comment) return false;
  let varray = comment[vote_type] || [];
  if (varray.includes(user_id)) return false;
  varray.push(user_id);
  return await global.comment.edit(news_id, comment_id, {[vote_type]: varray});
}

async function renderCommentsForNews(news_id, root = -1) {
  let html = '';
  let user = {};
  await comment.renderComments(news_id, root, async (c) => {
    if (!user[c.id]) user[c.id] = await getUserById(c.user_id);
    if (!user[c.id]) user[c.id] = deletedUser;
    let u = user[c.id];
    html += commentToHtml(c, u);
  });
  return html ? $h.div({'id': 'comments'}, html) : '';
}

async function renderCommentSubthread(comment, sep=''){
  let u = await getUserById(comment.user_id) || deletedUser;
  let comments = await renderCommentsForNews(comment.thread_id, + comment.id);
  return $h.div({class: "singlecomment"}, commentToHtml(comment, u, true)) + (comments ?
    $h.div({class: "commentreplies"}, sep + comments) : '');
}

// Given a string returns the same string with all the urls converted into
// HTML links. We try to handle the case of an url that is followed by a period
// Like in "I suggest http://google.com." excluding the final dot from the link.
function urlsToLinks(s) {
  let urls = /((https?:\/\/|www\.)([-\w\.]+)+(:\d+)?(\/([\w\/_#:\.\-\%]*(\?\S+)?)?)?)/;
  return s.replace(urls, (match, $1, $2) => {
    let url = text = $1;
    if ($2 == 'www.') url = `http://${url}`;
    if ($1.substr(-1, 1) == '.') {
      url = url.slice(0, url.length-1);
      text = text.slice(0, url.length-1);
      return `<a rel="nofollow" href="${url}">${text}</a>.`;
    } else {
      return `<a rel="nofollow" href="${url}">${text}</a>`;
    }
  });
}

module.exports = {
  Comment: Comment,
  commentToHtml: commentToHtml,
  computeCommentScore: computeCommentScore,
  getUserComments: getUserComments,
  insertComment: insertComment,
  voteComment: voteComment,
  renderCommentsForNews: renderCommentsForNews,
  renderCommentSubthread: renderCommentSubthread,
  urlsToLinks: urlsToLinks
}
