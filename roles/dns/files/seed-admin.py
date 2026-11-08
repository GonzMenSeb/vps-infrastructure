import sys
from powerdnsadmin import create_app

login, email = sys.argv[1], sys.argv[2]
app = create_app()
with app.app_context():
    from powerdnsadmin.models.user import User

    if User.query.count() == 0:
        user = User(username=login, plain_text_password=None, firstname=login, lastname='', email=email)
        result = user.create_local_user()
        print('seeded' if result['status'] else 'failed: ' + str(result['msg']))
    else:
        print('present')
